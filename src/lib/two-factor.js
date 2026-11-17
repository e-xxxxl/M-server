import crypto from "node:crypto";

/**
 * Optional two-factor sign-in for staff, with an authenticator app (time-based one-time codes, RFC 6238: 6 digits,
 * 30 seconds, SHA-1, which every authenticator app supports). No outside library is used.
 *
 * - The secret is stored encrypted (AES-256-GCM, with the same 32-byte key that protects documents), never in clear.
 * - A code works once: the time step of the last accepted code is kept and an earlier or equal step is refused.
 * - Eight single-use recovery codes are made when it is switched on. Only their hashes are stored.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export const base32 = {
  encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
  },
  decode(text) {
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of String(text).toUpperCase().replace(/[\s=-]/g, "")) {
      const index = ALPHABET.indexOf(char);
      if (index < 0) throw new Error("Not base32");
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  },
};

export const newSecret = () => base32.encode(crypto.randomBytes(20));

/** The code for a secret at a time step (RFC 4226 with the step as the counter). */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32.decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * Checks a typed code. A code from one step either side is accepted (a phone clock that is a little off), but never a step
 * that was already used. Returns the step that matched, or null.
 */
export function verifyCode(secret, typed, { lastStep = 0, now = Date.now() } = {}) {
  const text = String(typed ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(text)) return null;
  const current = stepAt(now);
  let matched = null;
  for (const step of [current - 1, current, current + 1]) {
    const a = Buffer.from(codeAt(secret, step));
    const b = Buffer.from(text);
    // Compare every candidate in constant time, and keep the latest that matches.
    if (crypto.timingSafeEqual(a, b) && step > lastStep) matched = step;
  }
  return matched;
}

export const otpauthUrl = ({ issuer = "NMREP", account, secret }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---------------------------------------------------------------- the secret at rest
const keyOf = (config) => {
  const raw = Buffer.from(String(config.documents?.encryptionKey ?? ""), "base64");
  return raw.length === 32 ? raw : null;
};

/** Two-factor needs the server's 32-byte encryption key (the one that protects documents). Without it the feature is off. */
export const twoFactorAvailable = (config) => keyOf(config) !== null;

export function sealSecret(config, secret) {
  const key = keyOf(config);
  if (!key) throw new Error("Two-factor sign-in is not available: no encryption key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function openSecret(config, sealed) {
  const key = keyOf(config);
  if (!key || !sealed) return null;
  try {
    const [iv, tag, body] = String(sealed).split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- recovery codes
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const hashRecovery = (code) => crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

/** Eight codes like "K7MQ-4WXD". The plain codes are shown once; only the hashes are kept. */
export function newRecoveryCodes(count = 8) {
  const plain = Array.from({ length: count }, () => {
    const pick = () => Array.from(crypto.randomBytes(4), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${pick()}-${pick()}`;
  });
  return { plain, hashes: plain.map(hashRecovery) };
}

/** The stored hashes without the code that was just used, or null when the code is not one of them. */
export function useRecoveryCode(hashes, typed) {
  const hash = hashRecovery(typed);
  if (!/^[0-9a-f]{64}$/.test(hash) || String(typed ?? "").replace(/[^A-Za-z0-9]/g, "").length !== 8) return null;
  return hashes.includes(hash) ? hashes.filter((h) => h !== hash) : null;
}
