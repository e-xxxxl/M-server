import mongoose from "mongoose";
import { EmailToken } from "../models/EmailToken.js";
import { hashToken, newToken } from "./crypto.js";
import { accountDeletedEmail, passwordChangedEmail, paymentReceiptEmail, resetPasswordEmail, updateEmail, verifyEmail } from "./email-templates.js";
import { unsubscribeToken } from "./unsubscribe.js";
import { emailSettings, mailer } from "./mailer.js";

const HOUR = 60 * 60 * 1000;
const lifetime = { verify: 48 * HOUR, reset: HOUR };
/** Asking again within this time sends nothing new, so the endpoints cannot be used to flood someone's inbox. */
const THROTTLE_MS = 60 * 1000;

/** A fresh one-time token for the user, or null when one was sent a moment ago. Only its hash is stored. */
async function issueToken(user, type) {
  const recent = await EmailToken.exists({ user: user._id, type, createdAt: mongoose.trusted({ $gte: new Date(Date.now() - THROTTLE_MS) }) });
  if (recent) return null;
  await EmailToken.deleteMany({ user: user._id, type }); // only the newest link works
  const token = newToken();
  await EmailToken.create({ user: user._id, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + lifetime[type]) });
  return token;
}

/** Looks up a token from a link. Returns the record, or null when it is unknown or expired. */
export async function findToken(token, type) {
  return EmailToken.findOne({ tokenHash: hashToken(token), type, expiresAt: mongoose.trusted({ $gt: new Date() }) });
}

export const dropTokens = (user, type) => EmailToken.deleteMany({ user: user._id, type });

const deliver = (user, message) => void mailer.send({ to: user.email, ...message });

/** Sends the "confirm your email address" mail. Returns false when it was skipped because one was just sent. */
export async function sendVerification(user) {
  const token = await issueToken(user, "verify");
  if (!token) return false;
  deliver(user, verifyEmail(user, `${emailSettings().appUrl}/verify-email/#token=${token}`));
  return true;
}

/** The link carries the token after a #, so it is never sent to a web server or leaked in a referrer. */
export async function sendPasswordReset(user) {
  const token = await issueToken(user, "reset");
  if (!token) return false;
  deliver(user, resetPasswordEmail(user, `${emailSettings().appUrl}/reset-password/#token=${token}`));
  return true;
}

export function sendAccountDeleted(user) {
  deliver(user, accountDeletedEmail(user));
}

export function sendPasswordChanged(user) {
  deliver(user, passwordChangedEmail(user, `${emailSettings().appUrl}/login/`));
}

export function sendPaymentReceipt(user, { amount, reference, paidUntil }) {
  deliver(user, paymentReceiptEmail(user, { amount, reference, paidUntil, url: `${emailSettings().appUrl}/dashboard/` }));
}

/**
 * Emails an owner the headline of a notification, with a "Stop these emails" link. Skipped when email is off, when the
 * owner turned notification emails off, or when the account is not an active owner. `bulk` sends through the batch
 * queue (for a message that goes to many people). Returns true when a message was handed to the mailer.
 */
export async function sendNotificationEmail(userId, { title, body = "", link = "", bulk = false }) {
  if (!mailer.enabled || !emailSettings().notifications) return false;
  const { User } = await import("../models/User.js");
  const user = await User.findById(userId).select("email fullName role active emailNotifications");
  if (!user || user.active === false || user.role !== "msme_owner" || user.emailNotifications === false) return false;
  const path = link.startsWith("/dashboard/") ? link : "/dashboard/";
  const message = {
    to: user.email,
    ...updateEmail(user, title, `${emailSettings().appUrl}${path}`, {
      body,
      unsubscribeUrl: `${emailSettings().appUrl}/unsubscribe/#token=${unsubscribeToken(user._id)}`,
    }),
  };
  if (bulk) mailer.queue(message);
  else void mailer.send(message);
  return true;
}
