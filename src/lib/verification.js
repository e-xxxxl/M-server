import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { notify } from "../models/Notification.js";
import { VerificationCheck, checkTypes } from "../models/VerificationCheck.js";
import { ApiError } from "../middleware/errors.js";
import { matchesAny, phoneTail } from "./name-match.js";
import { prembly } from "./prembly.js";

/**
 * Automated checks (NIN, BVN, CAC, TIN) through the provider, feeding the manual review. A check never makes a
 * business Verified: it records an outcome for a reviewer and, when it passes, moves an Unverified business to
 * Pending Verification so it appears in the review queue. Only an administrator sets Verified.
 */

export const checkInfo = {
  nin: {
    label: "National Identification Number (NIN)",
    description: "Checks that the NIN belongs to you. We compare the name on the record with your account name and the owner name in your profile. We do not keep your NIN or the record.",
    needsNumber: true,
  },
  bvn: {
    label: "Bank Verification Number (BVN)",
    description: "Checks that the BVN belongs to you. We compare the name on the record with your account name and the owner name in your profile. We do not keep your BVN or the record.",
    needsNumber: true,
  },
  cac: {
    label: "CAC registration",
    description: "Checks the CAC registration number in your profile against the public company register and compares the registered name with your business name.",
    needsNumber: false,
  },
  tin: {
    label: "Tax Identification Number (TIN)",
    description: "Checks the TIN in your profile and compares the taxpayer name with your business or owner name.",
    needsNumber: false,
  },
};

const message = {
  Passed: "Checked and matched.",
  "Needs review": "We found a record, but it does not clearly match the details in your profile. Check your details, then try again, or wait for NMREP to review it.",
  "Not found": "We could not find a record for this number. Check that it is correct, then try again.",
};

// The CAC register's own codes for each kind of registration.
const companyTypes = {
  "Business name (sole owner or partnership)": "BN",
  "Private limited company": "RC",
  "Public limited company": "RC",
  "Limited liability partnership": "LLP",
  "Incorporated trustees (association or NGO)": "IT",
};

const inactive = /inactive|struck|dissolved|revoked|suspended|ceased|liquidat/i;

export const maskValue = (value) => "*".repeat(Math.max(0, value.length - 4)) + value.slice(-4);

/** A keyed fingerprint of a number. The same number always gives the same value, and the number cannot be recovered from it. */
export const fingerprint = (config, type, value) => createHmac("sha256", config.verification.hashKey).update(`${type}:${value}`).digest("hex");

export const verificationEnabled = (config) => prembly.enabled && String(config.verification.hashKey).length >= 32;

/** Whether a check can be run for this business now, and why not. */
export function applicability(type, business) {
  if (type === "cac") {
    if (!business.cacNumber) return "Add your CAC registration number to your business profile first.";
    if (!companyTypes[business.businessType]) return "Your business type is not registered with the CAC.";
  }
  if (type === "tin" && !business.tin) return "Add your Tax Identification Number to your business profile first.";
  return "";
}

/** The number a check is about: typed for NIN and BVN, taken from the profile for CAC and TIN. */
function valueFor(type, business, input) {
  if (type === "cac") return String(business.cacNumber).replace(/^(RC|BN|IT|LP|LLP)[\s-]*/i, "").trim();
  if (type === "tin") return String(business.tin).trim();
  return input.number;
}

/** What the owner is told. Never includes anything from the provider's record. */
export function ownerView(check) {
  return {
    type: check.type,
    label: checkInfo[check.type].label,
    status: check.status,
    maskedValue: check.maskedValue,
    checkedAt: check.checkedAt,
    message: message[check.status],
  };
}

/** What a reviewer sees: the outcome and the comparisons, still no names or numbers. */
export function reviewerView(check, duplicates = 0) {
  return {
    ...ownerView(check),
    nameMatch: check.nameMatch,
    phoneMatch: check.phoneMatch,
    registeredName: check.registeredName,
    companyStatus: check.companyStatus,
    reference: check.reference,
    consentAt: check.consentAt,
    otherBusinessesWithSameNumber: duplicates,
  };
}

/** The most recent check of each type for a business. */
export async function latestChecks(businessId) {
  const all = await VerificationCheck.find({ business: businessId }).sort({ checkedAt: -1 });
  const seen = new Set();
  return all.filter((c) => (seen.has(c.type) ? false : seen.add(c.type)));
}

/** How many other businesses have a check on the same number. A reviewer's signal, never shown to owners. */
export async function duplicatesOf(check) {
  const others = await VerificationCheck.distinct("business", {
    type: check.type,
    valueHash: check.valueHash,
    business: mongoose.trusted({ $ne: check.business }),
    status: mongoose.trusted({ $in: ["Passed", "Needs review"] }),
  });
  return others.length;
}

const inFlight = new Set();

/**
 * Runs one check. Throws ApiError for: feature off or provider unavailable (503), a number missing from the profile (422),
 * too many attempts (429) and a check already running (409).
 */
export async function runCheck({ config, business, user, input }) {
  const { type } = input;
  if (!verificationEnabled(config)) {
    throw new ApiError(503, "verification_unavailable", "Verification is not available right now. Please try again later.");
  }
  const problem = applicability(type, business);
  if (problem) throw new ApiError(422, "validation", "Please check the highlighted fields.", { type: problem });

  const value = valueFor(type, business, input);
  const hash = fingerprint(config, type, value);

  // The same number already passed for this business: answer from the record, without a (paid) provider call.
  const same = await VerificationCheck.findOne({ business: business._id, type, valueHash: hash, status: "Passed" }).sort({ checkedAt: -1 });
  if (same) return same;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await VerificationCheck.find({ business: business._id, checkedAt: mongoose.trusted({ $gte: since }) }).select("type");
  if (recent.filter((c) => c.type === type).length >= config.verification.maxPerTypePerDay || recent.length >= config.verification.maxPerDay) {
    throw new ApiError(429, "check_limit", "You have reached today's limit for this check. Please try again tomorrow.");
  }

  const key = `${business._id}:${type}`;
  if (inFlight.has(key)) throw new ApiError(409, "in_progress", "This check is already running. Please wait a moment.");
  inFlight.add(key);
  let result;
  try {
    result = await runProvider(type, business, user, value);
  } finally {
    inFlight.delete(key);
  }
  if (result.unavailable) throw new ApiError(503, "verification_unavailable", "Verification is not available right now. Please try again later.");

  const check = await VerificationCheck.create({
    business: business._id,
    owner: user._id,
    type,
    status: result.status,
    maskedValue: maskValue(value),
    valueHash: hash,
    nameMatch: result.nameMatch ?? null,
    phoneMatch: result.phoneMatch ?? null,
    registeredName: result.registeredName ?? "",
    companyStatus: result.companyStatus ?? "",
    reference: result.reference ?? "",
    consentAt: checkInfo[type].needsNumber ? new Date() : null,
  });

  // A passed check puts an unverified business in the review queue. It never grants Verified.
  if (check.status === "Passed" && business.verificationStatus === "Unverified") {
    business.verificationStatus = "Pending Verification";
    business.verificationHistory.push({ status: "Pending Verification", at: new Date(), note: `Automated check passed: ${checkInfo[type].label}`.slice(0, 200) });
    await business.save();
    await notify(business.owner, {
      type: "verification",
      title: "Your verification status is now: Pending Verification",
      body: "Your details are being reviewed.",
      link: "/dashboard/",
    });
  }
  return check;
}

/** Calls the provider and compares the answer with what NMREP holds. Returns { unavailable } or the outcome to store. */
async function runProvider(type, business, user, value) {
  if (type === "nin" || type === "bvn") {
    const r = await prembly[type](value);
    if (r.unavailable) return r;
    if (!r.found) return { status: "Not found", reference: r.reference };
    const official = [r.person.firstName, r.person.middleName, r.person.lastName].filter(Boolean).join(" ");
    const nameMatch = matchesAny(official, [user.fullName, business.ownerName]);
    const theirs = phoneTail(r.person.phone);
    const phoneMatch = theirs ? theirs === phoneTail(user.phone) : null;
    return { status: nameMatch ? "Passed" : "Needs review", nameMatch, phoneMatch, reference: r.reference };
  }
  if (type === "cac") {
    const r = await prembly.cac({ number: value, companyType: companyTypes[business.businessType], companyName: business.businessName });
    if (r.unavailable) return r;
    if (!r.found) return { status: "Not found", reference: r.reference };
    const nameMatch = matchesAny(r.company.name, [business.businessName, business.tradingName], { dropCompanyWords: true });
    const active = !inactive.test(r.company.status);
    return {
      status: nameMatch && active ? "Passed" : "Needs review",
      nameMatch,
      registeredName: r.company.name.slice(0, 200),
      companyStatus: r.company.status.slice(0, 40),
      reference: r.reference,
    };
  }
  const r = await prembly.tin(value);
  if (r.unavailable) return r;
  if (!r.found) return { status: "Not found", reference: r.reference };
  const nameMatch = matchesAny(r.taxpayer.name, [business.businessName, business.tradingName, business.ownerName, user.fullName], { dropCompanyWords: true });
  return { status: nameMatch ? "Passed" : "Needs review", nameMatch, reference: r.reference };
}

export { checkTypes };
