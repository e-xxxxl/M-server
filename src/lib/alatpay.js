/**
 * Bank transfer payments through ALATPay (https://alatpay.ng, by Wema Bank), over its plain HTTPS API. Written from the
 * documentation at https://docs.alatpay.ng.
 *
 * How a payment works: the server asks ALATPay for a one-time virtual account number for the exact amount
 * (POST /bank-transfer/api/v1/bankTransfer/virtualAccount). The payer transfers the amount to that account from any
 * bank within 24 hours. The server then asks ALATPay what happened to the transaction
 * (GET /alatpaytransaction/api/v1/transactions/{transactionId}); ALATPay also calls our webhook when a payment completes.
 *
 * - The secret key and the business id live only in the server's environment (ALATPAY_SECRET_KEY, ALATPAY_BUSINESS_ID).
 *   The secret key is sent only to ALATPay, in the Ocp-Apim-Subscription-Key header, and is never logged, returned or stored.
 * - A call never throws. It answers { unavailable: true } when ALATPay cannot be used right now (no key, network problem,
 *   timeout, 5xx, or our own key being refused), and otherwise a small provider-neutral object.
 * - A payment is trusted only after it is checked with ALATPay and the amount, currency, order id and business id match
 *   what the server asked for. The browser coming back, or a webhook, only tells us WHEN to check (the webhook carries no
 *   signature in the documentation, so nothing in it is believed).
 * - The amount is in naira (not kobo) on ALATPay's side.
 */

const TIMEOUT_MS = 20_000;

/** The bank that owns a virtual account, from its code. Only codes the documentation shows are named. */
const bankNames = { "035": "Wema Bank" };
export const bankNameFor = (code) => bankNames[String(code)] ?? (code ? `Bank (code ${code})` : "Bank");

/** What ALATPay's transaction status means for us. Only "completed" is paid; unknown words stay pending. */
export function normaliseStatus(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "completed") return "success";
  if (["failed", "expired", "cancelled", "canceled", "abandoned", "reversed", "declined"].includes(s)) return "failed";
  return "pending";
}

export function createAlatpay(cfg, { fetchImpl = fetch, log = console } = {}) {
  const enabled = Boolean(cfg?.secretKey && cfg?.businessId);

  async function call(method, path, body) {
    if (!enabled) return { unavailable: true };
    try {
      const res = await fetchImpl(cfg.baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json", "Ocp-Apim-Subscription-Key": cfg.secretKey },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if ([401, 403].includes(res.status)) {
        log.error(`ALATPay refused the request: HTTP ${res.status}. Check ALATPAY_SECRET_KEY and ALATPAY_BUSINESS_ID.`);
        return { unavailable: true };
      }
      if (res.status === 429 || res.status >= 500) return { unavailable: true };
      return { ok: res.ok && json?.status === true, status: res.status, data: json?.data ?? null, message: String(json?.message ?? "").slice(0, 120) };
    } catch (err) {
      log.error("ALATPay call failed:", err?.name ?? "error");
      return { unavailable: true };
    }
  }

  return {
    enabled,

    /**
     * Asks for a virtual account for one payment. Returns { transactionId, accountNumber, bankCode, expiresAt } for the
     * payer to transfer to, or { unavailable }.
     */
    async initialize({ orderId, amountNaira, email, phone, firstName, lastName, description = "NMREP registration fee" }) {
      if (!enabled) return { unavailable: true };
      const r = await call("POST", "/bank-transfer/api/v1/bankTransfer/virtualAccount", {
        businessId: cfg.businessId,
        amount: amountNaira,
        currency: "NGN",
        orderId,
        description,
        customer: { email, phone, firstName, lastName, metadata: JSON.stringify({ purpose: "registration" }) },
      });
      const d = r.data;
      if (r.unavailable || !r.ok || !d?.transactionId || !d?.virtualBankAccountNumber) return { unavailable: true };
      return {
        transactionId: String(d.transactionId),
        accountNumber: String(d.virtualBankAccountNumber),
        bankCode: String(d.virtualBankCode ?? ""),
        expiresAt: d.expiredAt ? new Date(d.expiredAt) : new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
    },

    /**
     * Asks ALATPay what happened to a transaction. Returns { found, status: "success" | "failed" | "pending", amountKobo,
     * currency, paidAt } or { unavailable }. A transaction that is not ours (another business, another order id) is
     * answered as not found.
     */
    async verify({ transactionId, orderId }) {
      const r = await call("GET", `/alatpaytransaction/api/v1/transactions/${encodeURIComponent(transactionId)}`);
      if (r.unavailable) return { unavailable: true };
      const d = r.data;
      if (!r.ok || !d) return { found: false };
      if (d.businessId && String(d.businessId).toLowerCase() !== String(cfg.businessId).toLowerCase()) return { found: false };
      if (orderId && d.orderId && String(d.orderId).toLowerCase() !== String(orderId).toLowerCase()) return { found: false };
      let status = normaliseStatus(d.status);
      // The payer sent a different amount than asked: never accepted as paid. It stays open until the account expires.
      if (d.isAmountDiscrepant === true) status = status === "failed" ? "failed" : "pending";
      return {
        found: true,
        status,
        amountKobo: Math.round(Number(d.amount) * 100),
        currency: String(d.currency ?? ""),
        paidAt: status === "success" && d.updatedAt ? new Date(d.updatedAt) : null,
      };
    },
  };
}

// One client for the whole process, set up once at start. Until then (and in tests) the feature is off.
let current = createAlatpay(null);

/** Called once by the server. */
export function configureAlatpay(config, options = {}) {
  current = createAlatpay(config.payments.alatpay, options);
  return current;
}

/** Tests put a fake client here. */
export function setAlatpay(client) {
  current = client;
}

export const alatpay = {
  get enabled() {
    return current.enabled;
  },
  initialize: (args) => current.initialize(args),
  verify: (args) => current.verify(args),
};
