import { Router } from "express";
import mongoose from "mongoose";
import { sendAccountDeleted, sendVerification } from "../lib/account-emails.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { ApiError } from "../middleware/errors.js";
import { clearSessionCookie, requireAuth } from "../middleware/security.js";
import { accountPatchSchema, deleteAccountSchema, notificationSettingsSchema, passwordChangeSchema, pushTokenBodySchema, twoFactorDisableSchema, twoFactorEnableSchema, twoFactorPasswordSchema } from "../schemas.js";
import { newRecoveryCodes, newSecret, openSecret, otpauthUrl, sealSecret, twoFactorAvailable, useRecoveryCode, verifyCode } from "../lib/two-factor.js";
import { audit } from "../models/AuditLog.js";
import { deleteOwnerData } from "../lib/account-deletion.js";
import { phoneKey } from "../lib/phone-key.js";
import { removeSessionDevices, removeUserDevices, saveDeviceToken } from "../lib/devices.js";

export function accountRoutes({ config, limiters }) {
  const router = Router();
  router.use(requireAuth(config));

  const settingsOf = (user) => ({ email: user.emailNotifications !== false, push: user.pushNotifications !== false });

  // Which notifications the owner also wants by email and on their phone. The in-app list always has all of them.
  router.get("/notification-settings", (req, res) => {
    res.json({ settings: settingsOf(req.user) });
  });
  router.patch("/notification-settings", async (req, res) => {
    const patch = notificationSettingsSchema.parse(req.body);
    if (patch.email !== undefined) req.user.emailNotifications = patch.email;
    if (patch.push !== undefined) req.user.pushNotifications = patch.push;
    await req.user.save();
    res.json({ settings: settingsOf(req.user) });
  });

  // The phone's push token for THIS sign-in: saves it, or replaces the one saved before. An empty string stops push to this
  // sign-in. Signing out (or "log out of all devices") stops delivery to it as well.
  router.post("/push-token", async (req, res) => {
    const { devicePushToken } = pushTokenBodySchema.parse(req.body);
    if (devicePushToken === "") {
      await removeSessionDevices(req.session._id);
      return void res.json({ registered: false });
    }
    await saveDeviceToken({ userId: req.user._id, token: devicePushToken, sessionId: req.session._id, replace: true });
    res.json({ registered: true });
  });

  router.patch("/", async (req, res) => {
    const patch = accountPatchSchema.parse(req.body);
    if (patch.phone && (await User.exists({ phoneKey: phoneKey(patch.phone), _id: mongoose.trusted({ $ne: req.user._id }) }))) {
      throw new ApiError(409, "phone_taken", "An account with this phone number already exists.", { phone: "An account with this phone number already exists." });
    }
    Object.assign(req.user, patch);
    await req.user.save();
    res.json({ user: req.user });
  });

  router.post("/password", limiters.login, async (req, res) => {
    const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);
    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", {
        currentPassword: "Your current password is incorrect.",
      });
    }
    if (newPassword === currentPassword) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", {
        newPassword: "Choose a password different from your current one.",
      });
    }
    user.passwordHash = await hashPassword(newPassword, config.bcryptRounds);
    user.mustChangePassword = false; // a temporary password has now been replaced
    await user.save();
    // Sign out everywhere else. This device stays signed in.
    await Session.deleteMany({ user: user._id, _id: mongoose.trusted({ $ne: req.session._id }) });
    res.json({ ok: true, user });
  });

  // ------------------------------------------------------- two-factor sign-in (staff only, optional)
  const staffOnly = (req) => {
    if (!["admin", "super_admin"].includes(req.user.role)) throw new ApiError(403, "forbidden", "Two-factor sign-in is for NMREP staff accounts.");
  };
  const withSecrets = (id) => User.findById(id).select("+passwordHash +twoFactorSecret +twoFactorLastStep +twoFactorRecovery");
  const wrongPassword = () => new ApiError(422, "validation", "Please check the highlighted fields.", { password: "Your password is incorrect." });

  router.get("/two-factor", async (req, res) => {
    staffOnly(req);
    const user = await withSecrets(req.user._id);
    res.json({ available: twoFactorAvailable(config), enabled: Boolean(user.twoFactorEnabled), recoveryCodesLeft: user.twoFactorEnabled ? (user.twoFactorRecovery ?? []).length : 0 });
  });

  // Step 1: a new secret for the authenticator app. Nothing is switched on until a code from the app is confirmed.
  router.post("/two-factor/setup", limiters.login, async (req, res) => {
    staffOnly(req);
    if (!twoFactorAvailable(config)) throw new ApiError(503, "two_factor_unavailable", "Two-factor sign-in is not available on this server yet. The server needs its encryption key (DOCUMENT_ENCRYPTION_KEY).");
    const { password } = twoFactorPasswordSchema.parse(req.body);
    const user = await withSecrets(req.user._id);
    if (!(await verifyPassword(password, user.passwordHash))) throw wrongPassword();
    if (user.twoFactorEnabled) throw new ApiError(409, "already_enabled", "Two-factor sign-in is already on. Switch it off first to set it up again.");
    const secret = newSecret();
    user.twoFactorSecret = sealSecret(config, secret);
    await user.save();
    res.json({ secret, otpauthUrl: otpauthUrl({ account: user.email, secret }) });
  });

  // Step 2: the first code from the app proves it was set up. Switches it on and returns the recovery codes, once.
  router.post("/two-factor/enable", limiters.login, async (req, res) => {
    staffOnly(req);
    const { code } = twoFactorEnableSchema.parse(req.body);
    const user = await withSecrets(req.user._id);
    if (user.twoFactorEnabled) throw new ApiError(409, "already_enabled", "Two-factor sign-in is already on.");
    const secret = openSecret(config, user.twoFactorSecret);
    if (!secret) throw new ApiError(409, "setup_first", "Start the setup first.");
    const step = verifyCode(secret, code, { lastStep: 0 });
    if (!step) throw new ApiError(422, "validation", "Please check the highlighted fields.", { code: "That code is not right. Wait for the next code in your app and try again." });
    const recovery = newRecoveryCodes();
    user.twoFactorEnabled = true;
    user.twoFactorLastStep = step;
    user.twoFactorRecovery = recovery.hashes;
    await user.save();
    await audit(req.user, "account.two-factor-on", "Switched on two-factor sign-in", { type: "user", id: user._id });
    res.json({ enabled: true, recoveryCodes: recovery.plain });
  });

  // Switching it off needs the password AND a current code (or a recovery code).
  router.post("/two-factor/disable", limiters.login, async (req, res) => {
    staffOnly(req);
    const { password, code } = twoFactorDisableSchema.parse(req.body);
    const user = await withSecrets(req.user._id);
    if (!(await verifyPassword(password, user.passwordHash))) throw wrongPassword();
    if (!user.twoFactorEnabled) throw new ApiError(409, "not_enabled", "Two-factor sign-in is not on.");
    const secret = openSecret(config, user.twoFactorSecret);
    const ok = (secret && verifyCode(secret, code, { lastStep: user.twoFactorLastStep ?? 0 })) || useRecoveryCode(user.twoFactorRecovery ?? [], code);
    if (!ok) throw new ApiError(422, "validation", "Please check the highlighted fields.", { code: "That code is not right." });
    user.twoFactorEnabled = false;
    user.twoFactorSecret = "";
    user.twoFactorLastStep = 0;
    user.twoFactorRecovery = [];
    await user.save();
    await audit(req.user, "account.two-factor-off", "Switched off two-factor sign-in", { type: "user", id: user._id });
    res.json({ enabled: false });
  });

  // Sends the confirmation email again. Asking twice within a minute sends only one.
  router.post("/resend-verification", limiters.reset, async (req, res) => {
    if (req.user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
    await sendVerification(req.user);
    res.json({ ok: true });
  });

  // Deletes the owner's account and everything personal that belongs to it. Needs the password again.
  // Consent records stay as an accountability record of what was shared, ended and with no profile data.
  router.delete("/", limiters.login, async (req, res) => {
    const { password } = deleteAccountSchema.parse(req.body);
    if (req.user.role !== "msme_owner") {
      throw new ApiError(403, "forbidden", "This account is managed by NMREP. Ask an administrator to remove it.");
    }
    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", { password: "Your password is incorrect." });
    }
    await deleteOwnerData(user);
    clearSessionCookie(res, config);
    sendAccountDeleted(user);
    res.status(204).end();
  });

  // "Log out of all devices", including this one.
  router.delete("/sessions", async (req, res) => {
    await removeUserDevices(req.user._id); // no push to any of this account's phones any more
    await Session.deleteMany({ user: req.user._id });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
