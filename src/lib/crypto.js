import crypto from "node:crypto";
import bcrypt from "bcryptjs";

/** Random session token for the cookie: 32 bytes, URL-safe. */
export const newToken = () => crypto.randomBytes(32).toString("base64url");

/** What is stored in the database in place of the token. */
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

export const hashPassword = (password, rounds) => bcrypt.hash(password, rounds);

export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

let dummy;
/**
 * Compare against a throwaway hash when the account does not exist, so a login for an
 * unknown email takes about as long as one for a real account.
 */
export async function burnPasswordCheck(password, rounds) {
  dummy ??= await bcrypt.hash("not-a-real-password", rounds);
  await bcrypt.compare(password, dummy);
}
