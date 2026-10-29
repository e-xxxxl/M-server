import crypto from "node:crypto";

/**
 * Card and bank payments through Paystack (https://paystack.com), over its plain HTTPS API.
 *
 * - The secret key lives only in the server's environment (PAYSTACK_SECRET_KEY). It is sent only to api.paystack.co,
 *   as a Bearer token, and is never logged, returned or stored. A test key (sk_test_...) works against Paystack's
 *   test mode with test cards: the same addresses, no real money.
 * - A call never throws. It answers { unavailable: true } when Paystack cannot be used right now (no key, network
 *   problem, timeout, 5xx, or our own key being refused), and otherwise a small provider-neutral object.
 * - A payment is trusted only after it is checked with Paystack (verify) and the amount and currency match what the
 *   server asked for. The browser coming back to the site, or a webhook, only tells us WHEN to check.
 */

const TIMEOUT_MS = 20_000;

export function createPaystack(cfg, { fetchImpl = fetch, log = console } = {}) {
  const enabled = Boolean(cfg?.secretKey);

  async function call(method, path, body) {
    if (!enabled) return { unavailable: true };
    try {
      const res = await fetchImpl(cfg.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if ([401, 403].includes(res.status)) {
        log.error(`Paystack refused the request: HTTP ${res.status}. Check PAYSTACK_SECRET_KEY.`);
        return { unavailable: true };
      }
      if (res.status === 429 || res.status >= 500) return { unavailable: true };
      return { ok: res.ok && json?.status === true, status: res.status, data: json?.data ?? null, message: String(json?.message ?? "").slice(0, 120) };
    } catch (err) {
      log.error("Paystack call failed:", err?.name ?? "error");
      return { unavailable: true };
    }
  }

  return {
    enabled,

    /** Starts a payment. Returns { authorizationUrl, reference } to send the payer to, or { unavailable }. */
    async initialize({ email, amountKobo, reference, callbackUrl, metadata }) {
      const r = await call("POST", "/transaction/initialize", { email, amount: amountKobo, currency: "NGN", reference, callback_url: callbackUrl, metadata });
      if (r.unavailable || !r.ok || !r.data?.authorization_url) return { unavailable: true };
      return { authorizationUrl: r.data.authorization_url, reference: r.data.reference ?? reference };
    },

    /** Asks Paystack what happened to a payment. Returns { status, amountKobo, currency, paidAt, reference } or { unavailable }. */
    async verify(reference) {
      const r = await call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      if (r.unavailable) return { unavailable: true };
      if (!r.ok || !r.data) return { found: false };
      return {
        found: true,
        status: String(r.data.status ?? ""),
        amountKobo: Number(r.data.amount),
        currency: String(r.data.currency ?? ""),
        paidAt: r.data.paid_at ? new Date(r.data.paid_at) : null,
        reference: String(r.data.reference ?? reference),
      };
    },
  };
}

/** True when `signature` is the HMAC SHA-512 of the raw request body with the secret key, as Paystack sends it. */
export function validSignature(rawBody, signature, secretKey) {
  if (!secretKey || typeof signature !== "string" || signature.length !== 128) return false;
  const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
}

// One client for the whole process, set up once at start. Until then (and in tests) the feature is off.
let current = createPaystack(null);

/** Called once by the server. */
export function configurePaystack(config, options = {}) {
  current = createPaystack(config.payments, options);
  return current;
}

/** Tests put a fake client here. */
export function setPaystack(client) {
  current = client;
}

export const paystack = {
  get enabled() {
    return current.enabled;
  },
  initialize: (args) => current.initialize(args),
  verify: (reference) => current.verify(reference),
};
