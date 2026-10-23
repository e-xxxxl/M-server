/**
 * Identity and business checks through Prembly (https://prembly.com), over its plain HTTPS API.
 *
 * - The API key lives only in the server's environment (PREMBLY_API_KEY). It is sent only to the Prembly host
 *   and never logged, returned or stored.
 * - Numbers (NIN, BVN) are sent in the request body only. Request and response bodies are never logged.
 * - A call never throws. It answers { unavailable: true } when the provider cannot be used right now (network
 *   problem, timeout, 5xx, rate limit, or our own key or wallet being refused), and otherwise { found, ... }.
 * - Only the few fields NMREP needs are returned, in a provider-neutral shape. Everything else the provider sends
 *   (date of birth, address, photo, directors, and so on) is dropped here and never leaves this file.
 *
 * Provider documentation used (docs.prembly.com): NIN basic POST /verification/vnin-basic, BVN basic POST
 * /verification/bvn_validation, CAC basic POST /verification/cac/basic, TIN POST /verification/tin. A request is
 * authenticated with the header x-api-key. A hit is HTTP 200 with status true and response_code "00". The
 * documentation does not describe failure responses or a sandbox, so anything that is not a hit counts as "not found".
 */

const TIMEOUT_MS = 20_000;

const clean = (v) => (typeof v === "string" ? v.trim() : "");

export function createPrembly(cfg, { fetchImpl = fetch, log = console } = {}) {
  const enabled = Boolean(cfg?.apiKey);

  async function call(path, body) {
    if (!enabled) return { unavailable: true };
    try {
      const res = await fetchImpl(cfg.baseUrl + path, {
        method: "POST",
        headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);

      // Our own key or wallet is the problem: log the status only (never the body) and report "unavailable".
      if ([401, 402, 403].includes(res.status)) {
        log.error(`Verification provider refused the request: HTTP ${res.status}. Check PREMBLY_API_KEY and the wallet balance.`);
        return { unavailable: true };
      }
      if (res.status === 429 || res.status >= 500) return { unavailable: true };

      const hit = res.ok && json?.status === true && String(json?.response_code) === "00";
      const reference = clean(json?.verification?.reference) || clean(json?.reference_id) || "";
      return { found: hit, data: hit ? (json.data ?? json.nin_data ?? {}) : null, reference: reference.slice(0, 80) };
    } catch (err) {
      log.error("Verification provider call failed:", err?.name ?? "error");
      return { unavailable: true };
    }
  }

  return {
    enabled,

    /** National Identification Number. Returns { found, person: { firstName, middleName, lastName, phone }, reference }. */
    async nin(number) {
      const r = await call("/verification/vnin-basic", { number });
      if (!r.found) return r;
      const d = r.data;
      return {
        found: true,
        reference: r.reference,
        person: { firstName: clean(d.firstname), middleName: clean(d.middlename), lastName: clean(d.surname), phone: clean(d.telephoneno) },
      };
    },

    /** Bank Verification Number. Same shape as nin(). */
    async bvn(number) {
      const r = await call("/verification/bvn_validation", { number });
      if (!r.found) return r;
      const d = r.data;
      return {
        found: true,
        reference: r.reference,
        person: { firstName: clean(d.firstName), middleName: clean(d.middleName), lastName: clean(d.lastName), phone: clean(d.phoneNumber) },
      };
    },

    /** CAC registration. companyType is BN, RC, IT, LP or LLP. Returns { found, company: { name, status, registeredOn, type }, reference }. */
    async cac({ number, companyType, companyName }) {
      const r = await call("/verification/cac/basic", {
        rc_number: number,
        company_type: companyType,
        ...(companyName ? { company_name: companyName } : {}),
      });
      if (!r.found) return r;
      const d = r.data;
      return {
        found: true,
        reference: r.reference,
        company: { name: clean(d.company_name), status: clean(d.company_status), registeredOn: clean(d.registrationDate), type: clean(d.company_type) },
      };
    },

    /** Tax Identification Number. Returns { found, taxpayer: { name }, reference }. */
    async tin(number) {
      const r = await call("/verification/tin", { number, channel: "TIN" });
      if (!r.found) return r;
      return { found: true, reference: r.reference, taxpayer: { name: clean(r.data.taxpayer_name) } };
    },
  };
}

// One client for the whole process, set up once at start. Until then (and in tests) the feature is off.
let current = createPrembly(null);

/** Called once by the server. */
export function configurePrembly(config, options = {}) {
  current = createPrembly(config.verification, options);
  return current;
}

/** Tests put a fake client here. */
export function setPrembly(client) {
  current = client;
}

export const prembly = {
  get enabled() {
    return current.enabled;
  },
  nin: (n) => current.nin(n),
  bvn: (n) => current.bvn(n),
  cac: (a) => current.cac(a),
  tin: (n) => current.tin(n),
};
