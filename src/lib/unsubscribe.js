import crypto from "node:crypto";

/**
 * The "stop these emails" link in notification emails. The token is the account id and a keyed signature of it, so
 * nothing needs to be stored and nobody can make a link for someone else's account. It only ever switches notification
 * emails off for that one account. Without UNSUBSCRIBE_SECRET a random key is made when the server starts, so links in
 * emails sent before a restart stop working: set the secret on a real server.
 */

let secret = crypto.randomBytes(32).toString("hex");
let fromEnvironment = false;

export function configureUnsubscribe(config) {
  if (config.notifications.unsubscribeSecret) {
    secret = config.notifications.unsubscribeSecret;
    fromEnvironment = true;
  }
  return fromEnvironment;
}

const sign = (id) => crypto.createHmac("sha256", secret).update(`unsubscribe:${id}`).digest("base64url").slice(0, 32);

export const unsubscribeToken = (userId) => `${userId}.${sign(String(userId))}`;

/** The account id inside a valid token, or null. */
export function userIdFromUnsubscribeToken(token) {
  const m = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{32})$/.exec(String(token));
  if (!m) return null;
  const expected = Buffer.from(sign(m[1]));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1] : null;
}
