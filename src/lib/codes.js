import crypto from "node:crypto";

// 32 characters with no 0, O, 1 or I, so a code read aloud or copied by hand is not misread.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A referral code such as NMR-7K3QXM (6 random characters, about 1 billion combinations). */
export function newReferralCode() {
  let out = "";
  for (const byte of crypto.randomBytes(6)) out += ALPHABET[byte % ALPHABET.length]; // 256 is a multiple of 32: no bias
  return `NMR-${out}`;
}

/**
 * Codes are compared in capitals with no spaces, and a missing hyphen is restored, so "nmr 7k3qxm",
 * "NMR7K3QXM" and "NMR-7K3QXM" are all the same code.
 */
export function normalizeReferralCode(value) {
  const compact = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  return /^NMR[A-Z0-9]{6}$/.test(compact) ? `NMR-${compact.slice(3)}` : compact;
}

const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/**
 * A temporary password for a new or reset admin account, shown to the super admin once.
 * Format xxxx-xxxx-xxxx with at least one letter and one digit. The admin must replace it at first login.
 */
export function newTemporaryPassword() {
  for (;;) {
    let raw = "";
    for (let i = 0; i < 12; i += 1) raw += PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
    if (/[A-Za-z]/.test(raw) && /[0-9]/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  }
}
