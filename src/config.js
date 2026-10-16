/**
 * Runtime configuration, read from environment variables (see .env.example).
 * Secrets such as MONGODB_URI live only in the server's environment, never in git.
 */

const list = (value, fallback) =>
  (value ?? fallback)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProd = nodeEnv === "production";
  return {
    nodeEnv,
    isProd,
    port: Number(env.PORT ?? 4000),
    // The address to listen on. The default (all addresses) suits Render. On a VPS behind nginx set HOST=127.0.0.1
    // so the API can only be reached through nginx.
    host: env.HOST || "0.0.0.0",
    mongodbUri: env.MONGODB_URI ?? "",
    // Browser origins allowed to call the API with credentials. No trailing slashes.
    corsOrigins: list(env.CORS_ORIGINS, "http://localhost:3000"),
    // Number of reverse proxies in front of the API (Render uses 1). Needed for correct client IPs.
    trustProxy: Number(env.TRUST_PROXY ?? (isProd ? 1 : 0)),
    session: {
      cookieName: env.SESSION_COOKIE_NAME ?? "nmrep_session",
      ttlDays: Number(env.SESSION_TTL_DAYS ?? 7),
      // Mobile and desktop apps (requests with "X-Client: app"). Their session slides: every use pushes the expiry
      // forward by appTtlDays, but never beyond appMaxDays after the login, so a stolen token cannot live forever.
      appTtlDays: Number(env.APP_SESSION_TTL_DAYS ?? 30),
      appMaxDays: Number(env.APP_SESSION_MAX_DAYS ?? 90),
      // "lax" works when the site and the API share a registrable domain (nmrep.ng and api.nmrep.ng).
      // Use "none" only if they are on unrelated domains; browsers that block third-party cookies will then break login.
      sameSite: (env.COOKIE_SAMESITE ?? "lax").toLowerCase(),
      domain: env.COOKIE_DOMAIN || undefined,
      secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : isProd,
      // TESTING ONLY. When true, login and registration also return the session token in the response and
      // the API accepts it as "Authorization: Bearer <token>", so the site works from a different domain
      // without cookies. Scripts on the page can read such a token, which is weaker than an httpOnly cookie.
      // Leave this off in production (api.nmrep.ng with cookies).
      allowBearer: env.ALLOW_TOKEN_AUTH === "true",
    },
    lockout: { maxFailures: 5, minutes: 15 },
    rateLimit: {
      windowMinutes: 15,
      login: Number(env.RATE_LIMIT_LOGIN ?? 15),
      register: Number(env.RATE_LIMIT_REGISTER ?? 10),
      general: Number(env.RATE_LIMIT_GENERAL ?? 600),
      // Forgot password, reset password, confirm email and resend: per IP address.
      reset: Number(env.RATE_LIMIT_RESET ?? 10),
    },
    bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
    // Email through Resend. Without RESEND_API_KEY and EMAIL_FROM, email is switched off and everything else still works.
    email: {
      apiKey: env.RESEND_API_KEY ?? "",
      // For example: NMREP <no-reply@nmrep.ng>. The domain must be verified in Resend.
      from: env.EMAIL_FROM ?? "",
      replyTo: env.EMAIL_REPLY_TO ?? "",
      // Where the links in emails point: the website. No trailing slash.
      appUrl: (env.APP_URL ?? (isProd ? "https://nmrep.ng" : "http://localhost:3000")).replace(/\/+$/, ""),
      // Also email owners about verification and application decisions. Set EMAIL_NOTIFICATIONS=false to stop that.
      notifications: env.EMAIL_NOTIFICATIONS !== "false",
    },
  };
}
