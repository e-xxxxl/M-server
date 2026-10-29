import { Router } from "express";
import { dropTokens, findToken, sendPasswordChanged, sendPasswordReset, sendVerification } from "../lib/account-emails.js";
import { applyComplianceRules } from "../lib/compliance.js";
import { Agent } from "../models/Agent.js";
import { Business } from "../models/Business.js";
import { Organisation } from "../models/Organisation.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from "../lib/crypto.js";
import { buildInsights } from "../lib/insights.js";
import { ApiError } from "../middleware/errors.js";
import { clearSessionCookie, isAppClient, readSessionToken, requireAuth, setSessionCookie } from "../middleware/security.js";
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema, unsubscribeSchema, verifyEmailSchema } from "../schemas.js";
import { registrationState } from "../lib/payments.js";
import { phoneKey } from "../lib/phone-key.js";
import { userIdFromUnsubscribeToken } from "../lib/unsubscribe.js";

const emailTaken = () =>
  new ApiError(409, "email_taken", "An account with this email address already exists.", {
    "account.email": "An account with this email address already exists.",
  });

const phoneTaken = () =>
  new ApiError(409, "phone_taken", "An account with this phone number already exists.", {
    "account.phone": "An account with this phone number already exists.",
  });

export function authRoutes({ config, limiters }) {
  const router = Router();

  async function startSession(req, res, userId) {
    // A new token on every login, so a stolen old token is useless.
    const old = readSessionToken(req, config);
    if (typeof old === "string" && old) await Session.deleteOne({ tokenHash: hashToken(old) });

    const DAY = 24 * 60 * 60 * 1000;
    const token = newToken();
    // The app gets a Bearer token (no cookie) whose session slides. Websites keep the httpOnly cookie.
    if (isAppClient(req)) {
      const expiresAt = new Date(Date.now() + Math.min(config.session.appTtlDays, config.session.appMaxDays) * DAY);
      await Session.create({ user: userId, tokenHash: hashToken(token), client: "app", userAgent: String(req.get("user-agent") ?? "").slice(0, 200), expiresAt });
      return { token, tokenExpiresAt: expiresAt };
    }
    await Session.create({
      user: userId,
      tokenHash: hashToken(token),
      userAgent: String(req.get("user-agent") ?? "").slice(0, 200),
      expiresAt: new Date(Date.now() + config.session.ttlDays * DAY),
    });
    setSessionCookie(res, config, token);
    // Legacy testing switch (ALLOW_TOKEN_AUTH): hand the token to the page as well.
    return config.session.allowBearer ? { token } : {};
  }

  router.post("/register", limiters.register, async (req, res) => {
    const body = registerSchema.parse(req.body);
    const { password, ...account } = body.account;
    applyComplianceRules(body.business, body.business, "business.");

    if (await User.exists({ email: account.email })) throw emailTaken();
    if (await User.exists({ phoneKey: phoneKey(account.phone) })) throw phoneTaken();

    // An optional referral code must belong to an active agent. The registrant is told only that
    // the code is not valid, never whose it is or whether it was switched off.
    let agent = null;
    if (body.referralCode) {
      agent = await Agent.findOne({ code: body.referralCode, active: true });
      if (!agent) {
        throw new ApiError(422, "validation", "Please check the highlighted fields.", {
          referralCode: "This referral code is not valid.",
        });
      }
    }

    const passwordHash = await hashPassword(password, config.bcryptRounds);

    let user;
    try {
      user = await User.create({ ...account, passwordHash, termsAcceptedAt: new Date() });
    } catch (err) {
      if (err?.code === 11000) throw emailTaken(); // two sign-ups with one email at the same moment
      throw err;
    }

    let business;
    try {
      business = await Business.create({
        ...body.business,
        owner: user._id,
        verificationHistory: [{ status: "Unverified", note: "Account created" }],
        referral: { agent: agent?._id ?? null, code: agent?.code ?? "" },
      });
    } catch (err) {
      await User.deleteOne({ _id: user._id }); // do not leave an account without a business behind
      throw err;
    }

    const extra = await startSession(req, res, user._id);
    await sendVerification(user); // queues the "confirm your email" message, never blocks sign-up on the mail service
    res.status(201).json({ user, business, insights: buildInsights(business), registration: registrationState(user, config), ...extra });
  });

  router.post("/login", limiters.login, async (req, res) => {
    const { identifier, email, password } = loginSchema.parse(req.body);
    const given = (identifier ?? email).trim();
    const failure = () =>
      new ApiError(
        401,
        "invalid_credentials",
        "Incorrect email, phone number or password. After several failed attempts an account is locked for a short time.",
      );

    // An email address has an "@". Anything else is read as a phone number, which must belong to exactly one account.
    let user = null;
    if (given.includes("@")) {
      user = await User.findOne({ email: given.toLowerCase() }).select("+passwordHash +failedLogins +lockUntil");
    } else {
      const key = phoneKey(given);
      if (key.length >= 7) {
        const matches = await User.find({ phoneKey: key }).select("+passwordHash +failedLogins +lockUntil").limit(2);
        if (matches.length === 1) user = matches[0];
      }
    }
    if (!user) {
      await burnPasswordCheck(password, config.bcryptRounds);
      throw failure();
    }

    const locked = user.lockUntil && user.lockUntil > new Date();
    const valid = await verifyPassword(password, user.passwordHash);

    // A partner can only log in while their organisation is active.
    const orgInactive = user.role === "partner" && !(await Organisation.exists({ _id: user.organisation, active: true }));
    const deactivated = user.active === false || orgInactive;

    if (locked || !valid || deactivated) {
      // The response is identical whether the account is locked, deactivated or the password is wrong.
      if (!locked && !valid) {
        user.failedLogins = (user.failedLogins ?? 0) + 1;
        if (user.failedLogins >= config.lockout.maxFailures) {
          user.lockUntil = new Date(Date.now() + config.lockout.minutes * 60 * 1000);
          user.failedLogins = 0;
        }
        await user.save();
      }
      throw failure();
    }

    user.failedLogins = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    await user.save();

    const extra = await startSession(req, res, user._id);
    const business = await Business.findOne({ owner: user._id });
    res.json({ user, business, insights: business ? buildInsights(business) : null, registration: registrationState(user, config), ...extra });
  });

  // Always the same answer, whether or not the email belongs to an account, so this cannot be used to find out who is registered.
  router.post("/forgot-password", limiters.reset, async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await User.findOne({ email });
    const orgOk = user?.role !== "partner" || (await Organisation.exists({ _id: user.organisation, active: true }));
    if (user && user.active !== false && orgOk) await sendPasswordReset(user);
    res.json({ ok: true });
  });

  router.post("/reset-password", limiters.reset, async (req, res) => {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const invalid = () =>
      new ApiError(422, "invalid_token", "This link is invalid or has expired. Request a new one.", { token: "This link is invalid or has expired. Request a new one." });
    const record = await findToken(token, "reset");
    if (!record) throw invalid();
    const user = await User.findById(record.user).select("+passwordHash");
    if (!user || user.active === false) throw invalid();

    user.passwordHash = await hashPassword(newPassword, config.bcryptRounds);
    user.mustChangePassword = false; // a temporary password has now been replaced
    user.failedLogins = 0;
    user.lockUntil = null;
    await user.save();
    await dropTokens(user, "reset"); // the link works once
    await Session.deleteMany({ user: user._id }); // everyone is signed out, so a stolen session stops working
    sendPasswordChanged(user);
    res.json({ ok: true });
  });

  router.post("/verify-email", limiters.reset, async (req, res) => {
    const { token } = verifyEmailSchema.parse(req.body);
    const record = await findToken(token, "verify");
    const user = record ? await User.findById(record.user) : null;
    if (!user) {
      throw new ApiError(422, "invalid_token", "This link is invalid or has expired. Request a new one.", { token: "This link is invalid or has expired. Request a new one." });
    }
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date();
      await user.save();
    }
    await dropTokens(user, "verify");
    res.json({ ok: true });
  });

  router.post("/logout", async (req, res) => {
    const token = readSessionToken(req, config);
    if (typeof token === "string" && token) await Session.deleteOne({ tokenHash: hashToken(token) });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get("/me", requireAuth(config), (req, res) => {
    // For the app, also the session's current expiry (it moves forward while the app is used).
    res.json({ user: req.user, registration: registrationState(req.user, config), ...(req.tokenExpiresAt ? { tokenExpiresAt: req.tokenExpiresAt } : {}) });
  });

  // The "Stop these emails" link in a notification email. No sign-in needed: the token proves which account it is for.
  router.post("/unsubscribe", limiters.reset, async (req, res) => {
    const { token } = unsubscribeSchema.parse(req.body);
    const id = userIdFromUnsubscribeToken(token);
    if (!id) throw new ApiError(400, "invalid_token", "This link is not valid.");
    await User.updateOne({ _id: id }, { $set: { emailNotifications: false } });
    res.json({ ok: true });
  });

  return router;
}
