/**
 * A phone number reduced to digits in one shape, so "0801 234 5678", "+234 801 234 5678" and "2348012345678" are the
 * same number. Nigerian numbers become 234 followed by the ten digits. Anything else is kept as its digits.
 * Kept apart from lib/phone.js so the User model can use it without importing the User model.
 */
export function phoneKey(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return digits;
  if (digits.startsWith("0") && digits.length === 11) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

/** Looks like a phone number (and not an email address). Used to decide how to read the sign-in field. */
export const looksLikePhone = (value) => !String(value).includes("@") && phoneKey(value).length >= 7;
