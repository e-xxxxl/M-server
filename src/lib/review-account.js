import crypto from "node:crypto";
import mongoose from "mongoose";
import { hashPassword } from "./crypto.js";
import { issueNmrepId } from "./ids.js";
import { Business } from "../models/Business.js";
import { User } from "../models/User.js";

/**
 * The account a store reviewer (Google Play, the App Store) signs in with. It is an ordinary business owner account with
 * its email confirmed and its registration fee paid for a while, so the reviewer sees the whole app without paying or
 * needing a NIN. The password is made here, shown once to whoever ran the command, and kept only as a hash.
 */

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const pick = (set) => set[crypto.randomInt(set.length)];

/** A random password that is easy to read out and type: no look-alike characters, always a letter and a digit. */
export function makeReviewPassword() {
  const chars = [pick(LETTERS), pick(DIGITS), ...Array.from({ length: 12 }, () => pick(LETTERS + DIGITS))];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const text = chars.join("");
  return `${text.slice(0, 5)}-${text.slice(5, 10)}-${text.slice(10)}`;
}

const SAMPLE_BUSINESS = {
  businessName: "Google Play Review Business",
  tradingName: "",
  businessType: "Private limited company",
  sector: "Retail and trading",
  industry: "General goods",
  yearEstablished: 2020,
  hasCac: "No",
  hasTin: "No",
  state: "Lagos",
  lga: "Ikeja",
  city: "Ikeja",
  address: "1 Review Street",
  ownerName: "Play Store Reviewer",
  ownerRole: "Owner and director",
  ownershipStructure: "Sole owner",
  employees: 5,
  annualRevenue: "5 to 25 million naira",
  existingLoans: "No",
  description: "A sample business for store reviewers. It does not represent a real company.",
};

/**
 * Creates the review account, or with `resetPassword` gives an existing one a new password and more paid time.
 * Returns { created, email, phone, password, paidUntil }. The password is only returned, never stored or logged.
 */
export async function createReviewAccount(config, { email, phone, years = 2, resetPassword = false, verified = false, now = new Date() }) {
  const existing = await User.findOne({ email });
  if (existing && !resetPassword) {
    const err = new Error("exists");
    err.code = "exists";
    throw err;
  }
  if (existing && existing.role !== "msme_owner") {
    const err = new Error("not_owner");
    err.code = "not_owner";
    throw err;
  }
  const password = makeReviewPassword();
  const passwordHash = await hashPassword(password, config.bcryptRounds);
  const paidUntil = new Date(now.getTime() + years * config.payments.periodDays * 24 * 60 * 60 * 1000);

  if (existing) {
    existing.passwordHash = passwordHash;
    existing.registrationPaidUntil = paidUntil;
    existing.active = true;
    existing.failedLogins = 0;
    existing.lockUntil = null;
    await existing.save();
    return { created: false, email, phone: existing.phone, password, paidUntil };
  }

  const user = await User.create({
    fullName: "Play Store Reviewer",
    email,
    phone,
    passwordHash,
    role: "msme_owner",
    termsAcceptedAt: now,
    emailVerifiedAt: now,
    registrationPaidUntil: paidUntil,
  });
  try {
    await Business.create({
      ...SAMPLE_BUSINESS,
      owner: user._id,
      verificationStatus: verified ? "Verified" : "Unverified",
      nmrepId: verified ? await issueNmrepId() : null,
      verificationHistory: [
        { status: "Unverified", note: "Account created for store review" },
        ...(verified ? [{ status: "Verified", note: "Set verified for store review" }] : []),
      ],
    });
  } catch (err) {
    await User.deleteOne({ _id: user._id }); // never leave an account without its business
    throw err;
  }
  return { created: true, email, phone, password, paidUntil };
}

/**
 * Reads the review account and says, check by check, whether a store reviewer can use it. Read only: it changes nothing.
 * `password` is optional; when given it is only compared with the stored hash. Each result is { label, ok, detail }
 * where ok is true, false, or null for something worth knowing that is not a fault.
 */
export async function inspectReviewAccount(config, { email, password = "", now = new Date() }) {
  const results = [];
  const add = (label, ok, detail = "") => results.push({ label, ok, detail });

  const user = await User.findOne({ email }).select("+passwordHash +failedLogins +lockUntil");
  add("The account exists", Boolean(user), user ? "" : `No account for ${email}. Run: npm run review-account`);
  if (!user) return results;

  add("It is a business owner account", user.role === "msme_owner", `role: ${user.role}`);
  add("It is active (not deactivated)", user.active !== false);
  add("It is not locked after failed sign-ins", !(user.lockUntil && user.lockUntil > now), user.lockUntil && user.lockUntil > now ? `locked until ${user.lockUntil.toISOString()}` : `${user.failedLogins ?? 0} failed attempts on record`);
  add("The email is confirmed (no banner)", Boolean(user.emailVerifiedAt));
  add("The terms were accepted", Boolean(user.termsAcceptedAt));

  if (!config.payments.enabled) add("The registration fee", null, "The fee is switched off on this server, so nobody sees the payment page.");
  else {
    const left = user.registrationPaidUntil ? (user.registrationPaidUntil.getTime() - now.getTime()) / (24 * 60 * 60 * 1000) : -1;
    add("The registration fee is paid (no payment page)", left > 0, left > 0 ? `paid until ${user.registrationPaidUntil.toISOString().slice(0, 10)} (${Math.floor(left)} days left)` : "Not paid or expired. Run: npm run review-account -- --reset-password");
    if (left > 0) add("There is enough paid time for a store review", left >= 60, left >= 60 ? "" : "Less than 60 days left. Run: npm run review-account -- --reset-password");
  }

  const businesses = await Business.find({ owner: user._id });
  add("It has exactly one business", businesses.length === 1, `${businesses.length} found`);
  const business = businesses[0];
  if (business) {
    let valid = true;
    try {
      await business.validate();
    } catch {
      valid = false;
    }
    add("The business record is complete and valid", valid);
    add("The business is not suspended", business.verificationStatus !== "Suspended", `status: ${business.verificationStatus}`);
    add("The business status", null, business.verificationStatus === "Verified" ? `Verified (${business.nmrepId})` : business.verificationStatus);
  }

  const sharing = user.phoneKey ? await User.countDocuments({ phoneKey: user.phoneKey, _id: mongoose.trusted({ $ne: user._id }) }) : 0;
  add("Its phone number is not shared with another account", sharing === 0, sharing ? `${sharing} other account(s) use it, so phone sign-in will not work` : user.phone);

  if (password) {
    const { verifyPassword } = await import("./crypto.js");
    add("The password you typed is correct", await verifyPassword(password, user.passwordHash));
  }

  // What the reviewer will meet on this server. Not faults of the account (shown as INFO when off), but worth knowing before submitting.
  add("Documents screen works", config.documents.encryptionKey ? true : null, config.documents.encryptionKey ? "" : "Document storage is OFF (DOCUMENT_ENCRYPTION_KEY): the Documents screen says it is not available");
  add("Automated verification is on", config.verification.apiKey && String(config.verification.hashKey).length >= 32 ? true : null, "If off, the Verify my NIN and CAC buttons are disabled");
  add("Email can be sent", config.email.apiKey && config.email.from ? true : null, "If off, no emails go out (password reset links included)");
  return results;
}
