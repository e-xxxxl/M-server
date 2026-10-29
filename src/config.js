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
    // The yearly registration fee, paid through Paystack. Without PAYSTACK_SECRET_KEY the fee is off and nobody is asked
    // to pay. Use a test key (sk_test_...) while testing: it takes test cards and no real money.
    payments: {
      secretKey: env.PAYSTACK_SECRET_KEY ?? "",
      baseUrl: (env.PAYSTACK_BASE_URL ?? "https://api.paystack.co").replace(/\/+$/, ""),
      enabled: Boolean(env.PAYSTACK_SECRET_KEY),
      registrationFeeNaira: Number(env.REGISTRATION_FEE_NAIRA ?? 1000),
      // How long one payment keeps the registration valid.
      periodDays: Number(env.REGISTRATION_PERIOD_DAYS ?? 365),
    },
    // Push notifications to the phone app through Expo. On by default: with no registered phones nothing is sent.
    push: {
      enabled: env.PUSH_ENABLED !== "false",
      accessToken: env.EXPO_ACCESS_TOKEN ?? "",
    },
    notifications: {
      // Signs the "stop these emails" links. Set a long random value on a real server.
      unsubscribeSecret: env.UNSUBSCRIBE_SECRET ?? "",
    },
    // The reminder job (programmes closing soon, training sessions tomorrow). Runs inside the API process.
    reminders: {
      enabled: env.REMINDERS_ENABLED !== "false",
      intervalMinutes: Number(env.REMINDERS_INTERVAL_MINUTES ?? 60),
    },
    // Automated identity and business checks through Prembly (NIN, BVN, CAC, TIN). Server side only. Without both
    // PREMBLY_API_KEY and VERIFICATION_HASH_KEY the feature is off and everything else still works.
    verification: {
      apiKey: env.PREMBLY_API_KEY ?? "",
      baseUrl: (env.PREMBLY_BASE_URL ?? "https://api.prembly.com").replace(/\/+$/, ""),
      // A long random secret used to fingerprint NIN and BVN numbers (HMAC), so the same number used on two accounts
      // can be noticed without the number itself ever being stored. Never change it after launch.
      hashKey: env.VERIFICATION_HASH_KEY ?? "",
      // Every provider call can cost money, so each type of check is limited per business per rolling 24 hours.
      maxPerTypePerDay: Number(env.VERIFICATION_MAX_PER_TYPE_PER_DAY ?? 3),
      maxPerDay: Number(env.VERIFICATION_MAX_PER_DAY ?? 8),
      // Prembly's test mode answers with made up data ("is_sandbox": true). Allowed everywhere except production.
      allowSandbox: nodeEnv !== "production",
    },
    // The document wallet. Files are encrypted (AES-256-GCM) before they are written to a private folder on this
    // server. Without a 32 byte key (base64) the wallet is off and everything else still works.
    documents: {
      dir: env.DOCUMENT_STORAGE_DIR || "storage/documents",
      encryptionKey: env.DOCUMENT_ENCRYPTION_KEY ?? "",
      maxFileBytes: Number(env.DOCUMENT_MAX_MB ?? 5) * 1024 * 1024,
      maxFiles: Number(env.DOCUMENT_MAX_FILES ?? 20),
      maxTotalBytes: Number(env.DOCUMENT_MAX_TOTAL_MB ?? 40) * 1024 * 1024,
    },
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
