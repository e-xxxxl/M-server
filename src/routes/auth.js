import { Router } from "express";
import { Agent } from "../models/Agent.js";
import { Business } from "../models/Business.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from "../lib/crypto.js";
import { buildInsights } from "../lib/insights.js";
import { ApiError } from "../middleware/errors.js";
import { clearSessionCookie, requireAuth, setSessionCookie } from "../middleware/security.js";
import { loginSchema, registerSchema } from "../schemas.js";

const emailTaken = () =>
  new ApiError(409, "email_taken", "An account with this email address already exists.", {
    "account.email": "An account with this email address already exists.",
  });

export function authRoutes({ config, limiters }) {
  const router = Router();

  async function startSession(req, res, userId) {
    // A new token on every login, so a stolen old token is useless.
    const old = req.cookies?.[config.session.cookieName];
    if (typeof old === "string" && old) await Session.deleteOne({ tokenHash: hashToken(old) });

    const token = newToken();
    await Session.create({
      user: userId,
      tokenHash: hashToken(token),
      userAgent: String(req.get("user-agent") ?? "").slice(0, 200),
      expiresAt: new Date(Date.now() + config.session.ttlDays * 24 * 60 * 60 * 1000),
    });
    setSessionCookie(res, config, token);
  }

  router.post("/register", limiters.register, async (req, res) => {
    const body = registerSchema.parse(req.body);
    const { password, ...account } = body.account;

    if (await User.exists({ email: account.email })) throw emailTaken();

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

    await startSession(req, res, user._id);
    res.status(201).json({ user, business, insights: buildInsights(business) });
  });

  router.post("/login", limiters.login, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const failure = () =>
      new ApiError(
        401,
        "invalid_credentials",
        "Incorrect email or password. After several failed attempts an account is locked for a short time.",
      );

    const user = await User.findOne({ email }).select("+passwordHash +failedLogins +lockUntil");
    if (!user) {
      await burnPasswordCheck(password, config.bcryptRounds);
      throw failure();
    }

    const locked = user.lockUntil && user.lockUntil > new Date();
    const valid = await verifyPassword(password, user.passwordHash);

    const deactivated = user.active === false;

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

    await startSession(req, res, user._id);
    const business = await Business.findOne({ owner: user._id });
    res.json({ user, business, insights: business ? buildInsights(business) : null });
  });

  router.post("/logout", async (req, res) => {
    const token = req.cookies?.[config.session.cookieName];
    if (typeof token === "string" && token) await Session.deleteOne({ tokenHash: hashToken(token) });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get("/me", requireAuth(config), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
