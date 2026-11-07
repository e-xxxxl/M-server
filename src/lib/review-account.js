import crypto from "node:crypto";
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
