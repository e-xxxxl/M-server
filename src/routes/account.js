import { Router } from "express";
import mongoose from "mongoose";
import { sendAccountDeleted, sendVerification } from "../lib/account-emails.js";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Document } from "../models/Document.js";
import { EmailToken } from "../models/EmailToken.js";
import { documentStorage } from "../lib/document-storage.js";
import { Notification } from "../models/Notification.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";
import { VerificationCheck } from "../models/VerificationCheck.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { ApiError } from "../middleware/errors.js";
import { clearSessionCookie, requireAuth } from "../middleware/security.js";
import { accountPatchSchema, deleteAccountSchema, notificationSettingsSchema, passwordChangeSchema } from "../schemas.js";
import { Device } from "../models/Device.js";
import { phoneKey } from "../lib/phone-key.js";

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
    await Application.deleteMany({ owner: user._id });
    await Notification.deleteMany({ user: user._id });
    await EmailToken.deleteMany({ user: user._id });
    // The wallet goes with the account: every file is removed from the disk, not only the records.
    for (const doc of await Document.find({ owner: user._id }).select("storageKey")) await documentStorage.remove(doc.storageKey);
    await Document.deleteMany({ owner: user._id });
    await VerificationCheck.deleteMany({ owner: user._id });
    await VerificationSubmission.deleteMany({ owner: user._id });
    await Device.deleteMany({ user: user._id });
    await TrainingRecord.deleteMany({ owner: user._id });
    await ConsentRecord.updateMany({ owner: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: "Account deleted" } });
    await Session.deleteMany({ user: user._id });
    await Business.deleteOne({ owner: user._id });
    await User.deleteOne({ _id: user._id });
    clearSessionCookie(res, config);
    sendAccountDeleted(user);
    res.status(204).end();
  });

  // "Log out of all devices", including this one.
  router.delete("/sessions", async (req, res) => {
    await Session.deleteMany({ user: req.user._id });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
