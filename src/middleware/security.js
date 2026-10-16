import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { Organisation } from "../models/Organisation.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { hashToken } from "../lib/crypto.js";
import { unauthenticated } from "./errors.js";

/**
 * True for requests from the mobile or desktop app, which identify themselves with "X-Client: app".
 * A website cannot send that header to this API: browsers ask permission first (a CORS preflight), and the
 * API never grants it, so only a native client can.
 */
export const isAppClient = (req) => req.get("x-client") === "app";

/** Response header carrying the session's current expiry (ISO 8601, UTC) on every authenticated app request. */
export const TOKEN_EXPIRES_HEADER = "X-Token-Expires-At";

/**
 * CSRF defence for cookie authentication. Browsers always send an Origin header on
 * POST, PATCH and DELETE, so any state-changing request must come from an allowed site.
 * This complements SameSite cookies and strict CORS rather than replacing them.
 */
export function requireAllowedOrigin(allowedOrigins) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    // A native app has no Origin and uses a Bearer token, which a browser never attaches by itself.
    if (!origin && isAppClient(req)) return next();
    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: { code: "forbidden_origin", message: "Request not allowed." } });
    }
    next();
  };
}

/**
 * The session token sent with a request: the cookie, or an "Authorization: Bearer" header from the app
 * ("X-Client: app"). The legacy ALLOW_TOKEN_AUTH switch also accepts a Bearer header without it.
 */
export function readSessionToken(req, config) {
  const fromCookie = req.cookies?.[config.session.cookieName];
  if (typeof fromCookie === "string" && fromCookie) return fromCookie;
  if (config.session.allowBearer || isAppClient(req)) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get("authorization") ?? "");
    if (match) return match[1];
  }
  return undefined;
}

/** Loads the session from the cookie. Rejects the request when there is none or it has expired. */
export function requireAuth(config) {
  return async (req, res, next) => {
    const token = readSessionToken(req, config);
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
    // App sessions slide: using the app keeps it signed in, up to a fixed maximum after the login.
    if (session.client === "app") {
      const DAY = 24 * 60 * 60 * 1000;
      const cap = session.createdAt.getTime() + config.session.appMaxDays * DAY;
      const wanted = Math.min(Date.now() + config.session.appTtlDays * DAY, cap);
      let expiresAt = session.expiresAt;
      if (wanted - expiresAt.getTime() > 60 * 60 * 1000) {
        expiresAt = new Date(wanted);
        await Session.updateOne({ _id: session._id }, { $set: { expiresAt } });
      }
      // The app can read the current expiry from every response, so it never has to guess.
      req.tokenExpiresAt = expiresAt;
      res.set(TOKEN_EXPIRES_HEADER, expiresAt.toISOString());
    }
    // A partner whose organisation has been switched off is signed out.
    if (user.role === "partner") {
      const org = await Organisation.findById(user.organisation).select("active").lean();
      if (!org || !org.active) {
        await session.deleteOne();
        throw unauthenticated();
      }
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
    reset: rateLimit({ ...base, limit: config.rateLimit.reset, handler: limited("Too many attempts. Please try again later.") }),
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
