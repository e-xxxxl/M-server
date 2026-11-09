import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { notify } from "../models/Notification.js";
import { VerificationCheck, checkTypes } from "../models/VerificationCheck.js";
import { ApiError } from "../middleware/errors.js";
import { matchesAny, phoneTail } from "./name-match.js";
import { issueNmrepId } from "./ids.js";
import { alertNeedsReviewer } from "./staff-alerts.js";
import { prembly } from "./prembly.js";

/**
 * Automated checks (NIN and CAC) through the provider, feeding the manual review. The NIN is required of every owner (not every
 * business has a CAC number); the CAC check is only for businesses that are registered with the CAC. A check never makes a
 * business Verified: it records an outcome for a reviewer and, when it passes, moves an Unverified business to
 * Pending Verification so it appears in the review queue. Only an administrator sets Verified.
 */

export const checkInfo = {
  nin: {
    label: "National Identification Number (NIN)",
    description: "Checks that the NIN belongs to you. We compare the name on the record with your account name and the owner name in your profile. We do not keep your NIN or the record. Required for every business.",
    needsNumber: true,
    required: true,
  },
  cac: {
    label: "CAC registration",
    description: "Only for businesses registered with the CAC. Type your CAC registration number. We look it up on the public company register, compare the registered name with your business name, and compare the number with the one you gave when you registered. If the two numbers differ, you choose which one to keep.",
    needsNumber: false,
    required: false,
  },
};

const message = {
  Passed: "Checked and matched.",
  "Needs review": "We found a record, but the name on it does not clearly match your details. Write your name or business name exactly as it is on the record, then try again, or wait for NMREP to review it.",
  "Not found": "We could not find a record for this number. Check that it is correct, then try again.",
};
const cacMessage = {
  Passed: "Your CAC registration was found and the name matches.",
  "Needs review": "We found this CAC number, but the registered name or status does not clearly match your business. NMREP staff will review it. You can also correct your business name in your profile and try again.",
  "Not found": "We could not find this number on the CAC register. Check the number and your business type (a business name, a private or public company, or incorporated trustees), then try again.",
};

// The CAC register's own codes for each kind of registration.
const companyTypes = {
  "Business name (sole owner or partnership)": "BN",
  "Private limited company": "RC",
  "Public limited company": "RC",
  "Incorporated trustees (association or NGO)": "IT",
};

/** A CAC number as it is sent to the register: without the RC, BN or IT in front, and without spaces. Leading zeros are kept. */
const cleanCac = (value) => String(value ?? "").trim().toUpperCase().replace(/^(RC|BN|IT|LP|LLP)[\s-]*/, "").replace(/\s+/g, "");
/** The same number for comparing only: letters and digits, no leading zeros, so "RC 0123456" and "123456" are one number. */
const cacKey = (value) => cleanCac(value).replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");

const inactive = /inactive|struck|dissolved|revoked|suspended|ceased|liquidat/i;

export const maskValue = (value) => "*".repeat(Math.max(0, value.length - 4)) + value.slice(-4);

/** A keyed fingerprint of a number. The same number always gives the same value, and the number cannot be recovered from it. */
export const fingerprint = (config, type, value) => createHmac("sha256", config.verification.hashKey).update(`${type}:${value}`).digest("hex");

export const verificationEnabled = (config) => prembly.enabled && String(config.verification.hashKey).length >= 32;

/** Whether a check can be run for this business now, and why not. */
export function applicability(type, business) {
  if (type === "cac") {
    if (business.businessType === "Limited liability partnership") return "Limited liability partnerships cannot be checked automatically yet. NMREP staff will review your CAC number.";
    if (!companyTypes[business.businessType]) return "Your business type says it is not registered with the CAC. If that is wrong, change the business type in your profile first.";
  }
  return "";
}

/**
 * Which CAC number to check. The owner types one. It is compared with the one given at registration (on the profile):
 * the same number is simply checked; a different number is not checked until the owner says which to keep for good
 * (`use`: "entered" or "profile"), so nothing is changed behind their back. Returns { value, adopt }: adopt means the
 * typed number should become the profile's number once the register has confirmed it.
 */
function planCac(business, input) {
  const typed = cleanCac(input.number);
  const onFile = cleanCac(business.cacNumber);
  if (!typed && !onFile) throw new ApiError(422, "validation", "Please check the highlighted fields.", { number: "Enter your CAC registration number." });
  if (!typed) return { value: onFile, adopt: false };
  if (!onFile) return { value: typed, adopt: true };
  if (cacKey(typed) === cacKey(onFile)) return { value: typed, adopt: false };
  if (input.use === "profile") return { value: onFile, adopt: false };
  if (input.use === "entered") return { value: typed, adopt: true };
  throw new ApiError(409, "cac_mismatch", "The CAC number you typed is different from the one you gave when you registered. Choose the one to use permanently.", { entered: typed, onFile });
}

/** Makes the typed CAC number the profile's number, with a note in the history. */
async function adoptCac(business, value) {
  const before = business.cacNumber;
  business.cacNumber = value;
  business.hasCac = "Yes";
  business.verificationHistory.push({ status: business.verificationStatus, at: new Date(), note: before ? "CAC number changed after a check found it on the register" : "CAC number added after a check found it on the register" });
  await business.save();
}


/** What the owner is told. Never includes anything from the provider's record. */
export function ownerView(check) {
  return {
    type: check.type,
    label: checkInfo[check.type].label,
    status: check.status,
    maskedValue: check.maskedValue,
    checkedAt: check.checkedAt,
    message: (check.type === "cac" ? cacMessage : message)[check.status],
    // The CAC register is public, so the owner may be told what it shows. This is what to correct when the names differ.
    ...(check.type === "cac" && check.registeredName ? { registeredName: check.registeredName } : {}),
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
  // Checks of a kind that is no longer offered (BVN and TIN were removed) are kept on file but not shown.
  return all.filter((c) => checkTypes.includes(c.type) && (seen.has(c.type) ? false : seen.add(c.type)));
}

/** True when a NIN check has found a record for this business (whether or not the names matched: a reviewer decides that). */
export async function ninChecked(businessId) {
  return Boolean(await VerificationCheck.exists({ business: businessId, type: "nin", status: mongoose.trusted({ $in: ["Passed", "Needs review"] }) }));
}

/**
 * Sign-up: keeps the last four digits and a keyed fingerprint of the NIN on the business, then runs the NIN check when
 * automated checks are on. The check never blocks or fails the sign-up: if the provider is slow or unavailable the owner
 * simply runs it later from Verification. The number itself is never stored or logged.
 */
export async function recordRegistrationNin({ config, business, user, nin, waitMs = 8000 }) {
  business.ninMasked = maskValue(nin);
  if (String(config.verification.hashKey).length >= 32) business.ninHash = fingerprint(config, "nin", nin);
  await business.save();
  if (!verificationEnabled(config)) return null;
  const run = runCheck({ config, business, user, input: { type: "nin", number: nin, consent: true } }).catch(() => null);
  return Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(null), waitMs).unref?.())]);
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

  // The CAC number may be typed; if it differs from the one on the profile the owner must choose before anything is checked.
  const plan = type === "cac" ? planCac(business, input) : null;
  const value = plan ? plan.value : input.number;
  const hash = fingerprint(config, type, plan ? cacKey(value) : value);

  // The same number already passed for this business: answer from the record, without a (paid) provider call.
  const same = await VerificationCheck.findOne({ business: business._id, type, valueHash: hash, status: "Passed" }).sort({ checkedAt: -1 });
  if (same) {
    if (plan?.adopt) {
      await adoptCac(business, value);
      same.adoptedNumber = value;
    }
    return same;
  }

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

  // The typed CAC number replaces the profile's only once the register has really found it.
  if (plan?.adopt && check.status !== "Not found") {
    await adoptCac(business, value);
    check.adoptedNumber = value;
  }

  // A record was found but a person has to decide: tell the staff inbox.
  if (check.status === "Needs review") {
    alertNeedsReviewer(config, {
      business,
      user,
      type,
      reason: type === "nin" ? "a record was found in a name that does not match the account or the owner name." : "the registered name or status does not match the business.",
    });
  }

  // A NIN that the provider confirms and whose name matches verifies the business at once, and issues its NMREP ID. Staff can
  // still change the status later. A business staff have Rejected or Suspended is never changed by a check.
  if (type === "nin" && check.status === "Passed" && ["Unverified", "Pending Verification"].includes(business.verificationStatus)) {
    business.verificationStatus = "Verified";
    business.verificationHistory.push({ status: "Verified", at: new Date(), note: "NIN confirmed automatically" });
    if (!business.nmrepId) business.nmrepId = await issueNmrepId();
    await business.save();
    await notify(business.owner, {
      type: "verification",
      title: "Your business is verified",
      body: `Your NIN was confirmed. Your NMREP Business ID is ${business.nmrepId}.`,
      link: "/dashboard/",
    });
    return check;
  }

  // Any other passed check (for example the CAC) puts an unverified business in the review queue.
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
  if (type === "nin") {
    const r = await prembly.nin(value);
    if (r.unavailable) return r;
    if (!r.found) return { status: "Not found", reference: r.reference };
    const official = [r.person.firstName, r.person.middleName, r.person.lastName].filter(Boolean).join(" ");
    const nameMatch = matchesAny(official, [user.fullName, business.ownerName]);
    const theirs = phoneTail(r.person.phone);
    const phoneMatch = theirs ? theirs === phoneTail(user.phone) : null;
    return { status: nameMatch ? "Passed" : "Needs review", nameMatch, phoneMatch, reference: r.reference };
  }
  // The register is asked by number and type only; the names are compared here.
  const r = await prembly.cac({ number: value, companyType: companyTypes[business.businessType] });
  if (r.unavailable) return r;
  if (!r.found) return { status: "Not found", reference: r.reference };
  // A business name is often registered in the owner's name, so the owner's name counts too.
  const nameMatch = matchesAny(r.company.name, [business.businessName, business.tradingName, business.ownerName, user.fullName], { dropCompanyWords: true });
  const active = !inactive.test(r.company.status);
  return {
    status: nameMatch && active ? "Passed" : "Needs review",
    nameMatch,
    registeredName: r.company.name.slice(0, 200),
    companyStatus: r.company.status.slice(0, 40),
    reference: r.reference,
  };
}

export { checkTypes };
