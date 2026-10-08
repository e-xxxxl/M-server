import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { hashToken } from "../lib/crypto.js";
import { unauthenticated } from "./errors.js";

/**
 * CSRF defence for cookie authentication. Browsers always send an Origin header on
 * POST, PATCH and DELETE, so any state-changing request must come from an allowed site.
 * This complements SameSite cookies and strict CORS rather than replacing them.
 */
export function requireAllowedOrigin(allowedOrigins) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: { code: "forbidden_origin", message: "Request not allowed." } });
    }
    next();
  };
}

/** Loads the session from the cookie. Rejects the request when there is none or it has expired. */
export function requireAuth(config) {
  return async (req, _res, next) => {
    const token = req.cookies?.[config.session.cookieName];
    if (typeof token !== "string" || token.length === 0 || token.length > 200) throw unauthenticated();

    // sanitizeFilter treats query operators as plain data. This one is written by us, so it is marked trusted.
    const session = await Session.findOne({
      tokenHash: hashToken(token),
      expiresAt: mongoose.trusted({ $gt: new Date() }),
    });
    if (!session) throw unauthenticated();

    const user = await User.findById(session.user);
    if (!user || user.active === false) {
      // The account is gone or has been deactivated: end this session too.
      await session.deleteOne();
      throw unauthenticated();
    }
    req.user = user;
    req.session = session;
    next();
  };
}

/** Allows only the listed roles. Used after requireAuth. */
export const requireRole =
  (...allowed) =>
  (req, res, next) => {
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: { code: "forbidden", message: "You do not have access to this." } });
    }
    next();
  };

/** Admins must replace their temporary password before using any admin feature. */
export function requirePasswordChanged(req, res, next) {
  if (req.user.mustChangePassword) {
    return res.status(403).json({
      error: { code: "password_change_required", message: "Please change your temporary password before continuing." },
    });
  }
  next();
}

const limited = (message) => (_req, res) =>
  res.status(429).json({ error: { code: "rate_limited", message } });

/**
 * Per-IP rate limits. The counters live in this process's memory, so they reset on
 * restart and are not shared if you run several instances. Fine for one instance;
 * use a shared store (for example Redis) before scaling out.
 */
export function createLimiters(config) {
  const windowMs = config.rateLimit.windowMinutes * 60 * 1000;
  const base = { windowMs, standardHeaders: "draft-7", legacyHeaders: false };
  return {
    general: rateLimit({ ...base, limit: config.rateLimit.general, handler: limited("Too many requests. Please slow down.") }),
    login: rateLimit({ ...base, limit: config.rateLimit.login, handler: limited("Too many attempts. Please try again later.") }),
    register: rateLimit({ ...base, limit: config.rateLimit.register, handler: limited("Too many attempts. Please try again later.") }),
  };
}

export function setSessionCookie(res, config, token) {
  const { cookieName, ttlDays, sameSite, domain, secure } = config.session;
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: "/",
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res, config) {
  const { cookieName, sameSite, domain, secure } = config.session;
  res.clearCookie(cookieName, { httpOnly: true, secure, sameSite, domain, path: "/" });
}
