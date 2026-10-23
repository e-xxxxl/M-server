/**
 * Compares a name from an official record with a name NMREP holds. Deliberately simple and explainable:
 * both names are lower-cased, stripped of accents and punctuation and split into words. They match when every
 * word of the shorter name appears in the longer one, in any order, and the shorter name has at least two words
 * (or is a single word that is also the whole of the other name). Company suffixes such as "Limited" are ignored.
 * Nothing here guesses: a near miss is "does not match" and goes to a person for review.
 */

const NOISE = new Set(["ltd", "limited", "plc", "llp", "nig", "nigeria", "enterprises", "enterprise", "company", "co", "and", "the", "of", "inc"]);

export function nameWords(value, { dropCompanyWords = false } = {}) {
  const words = String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return dropCompanyWords ? words.filter((w) => !NOISE.has(w)) : words;
}

/** True when the two names are the same person or company by the rule above. */
export function namesMatch(a, b, options = {}) {
  const x = nameWords(a, options);
  const y = nameWords(b, options);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const set = new Set(long);
  if (!short.every((w) => set.has(w))) return false;
  return short.length >= 2 || long.length === 1;
}

/** True when `official` matches any of the candidate names. */
export const matchesAny = (official, candidates, options) => candidates.filter(Boolean).some((c) => namesMatch(official, c, options));

/** The last ten digits of a phone number, for comparing "+234 801 234 5678" with "08012345678". */
export const phoneTail = (value) => String(value ?? "").replace(/\D/g, "").slice(-10);
