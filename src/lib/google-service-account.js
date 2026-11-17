import crypto from "node:crypto";
import fs from "node:fs";

/**
 * A Google service account, used by the server to call a Google API as itself (here: the Google Play Developer API).
 * The key is read once at start from one of three places and never logged, never returned by the API, never stored in
 * the database. A problem is reported by reason only.
 */

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 15_000;
const b64url = (input) => Buffer.from(input).toString("base64url");

/** Reads the service account from inline JSON, a file path, or base64 text. Returns { clientEmail, privateKey, tokenUri } or null. */
export function loadServiceAccount({ json = "", file = "", base64 = "" } = {}, { log = console, label = "Google service account" } = {}) {
  if (!json && !file && !base64) return null;
  let parsed;
  try {
    const text = json || (file ? fs.readFileSync(file, "utf8") : Buffer.from(base64, "base64").toString("utf8"));
    parsed = JSON.parse(text);
  } catch (err) {
    log.error(`${label} could not be read (${json ? "json" : file ? "file" : "base64"}): ${err?.code ?? err?.name ?? "error"}.`);
    return null;
  }
  const tokenUri = String(parsed.token_uri || DEFAULT_TOKEN_URI);
  const ok = typeof parsed.client_email === "string" && typeof parsed.private_key === "string" && parsed.private_key.includes("PRIVATE KEY") && tokenUri.startsWith("https://");
  if (!ok) {
    log.error(`${label} is not valid: it needs client_email and private_key. Download a new key from the Google Cloud console.`);
    return null;
  }
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key, tokenUri };
}

/** A function that gives a short lived access token for the scope (kept in memory, renewed a minute before it ends). Null when Google refuses. */
export function createTokenSource(credentials, scope, { fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
  let cached = null;
  return async function accessToken(force = false) {
    if (!force && cached && cached.expiresAt - 60_000 > now()) return cached.value;
    try {
      const iat = Math.floor(now() / 1000);
      const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
        JSON.stringify({ iss: credentials.clientEmail, scope, aud: credentials.tokenUri, iat, exp: iat + 3600 }),
      )}`;
      const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), credentials.privateKey).toString("base64url");
      const res = await fetchImpl(credentials.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.access_token) {
        log.error(`Google did not give an access token: HTTP ${res.status}. Check the service account key.`);
        return null;
      }
      cached = { value: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
      return cached.value;
    } catch (err) {
      log.error("Google sign-in failed:", err?.name ?? "error");
      return null;
    }
  };
}
