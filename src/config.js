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
    mongodbUri: env.MONGODB_URI ?? "",
    // Browser origins allowed to call the API with credentials. No trailing slashes.
    corsOrigins: list(env.CORS_ORIGINS, "http://localhost:3000"),
    // Number of reverse proxies in front of the API (Render uses 1). Needed for correct client IPs.
    trustProxy: Number(env.TRUST_PROXY ?? (isProd ? 1 : 0)),
    session: {
      cookieName: env.SESSION_COOKIE_NAME ?? "nmrep_session",
      ttlDays: Number(env.SESSION_TTL_DAYS ?? 7),
      // "lax" works when the site and the API share a registrable domain (nmrep.ng and api.nmrep.ng).
      // Use "none" only if they are on unrelated domains; browsers that block third-party cookies will then break login.
      sameSite: (env.COOKIE_SAMESITE ?? "lax").toLowerCase(),
      domain: env.COOKIE_DOMAIN || undefined,
      secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : isProd,
    },
    lockout: { maxFailures: 5, minutes: 15 },
    rateLimit: {
      windowMinutes: 15,
      login: Number(env.RATE_LIMIT_LOGIN ?? 15),
      register: Number(env.RATE_LIMIT_REGISTER ?? 10),
      general: Number(env.RATE_LIMIT_GENERAL ?? 600),
    },
    bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
  };
}
