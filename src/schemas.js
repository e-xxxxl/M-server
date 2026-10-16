import { z } from "zod";
import * as o from "./options.js";
import { normalizeReferralCode } from "./lib/codes.js";

// Plain wording for the two mistakes a client most often makes: leaving a field out, and sending it empty.
// Every other message is written next to its rule below.
z.config({
  customError: (issue) => {
    if (issue.code === "invalid_type" && issue.input === undefined) return "This field is required.";
    if (issue.code === "too_small" && issue.origin === "string" && issue.minimum === 1) return "This field is required.";
    return undefined;
  },
});

/**
 * Request validation. Every schema is strict: unknown keys are rejected, so a client
 * can never set fields it should not (verification status, NMREP ID, roles, and so on).
 * Values are typed strings and numbers, so MongoDB operator objects such as
 * { "$gt": "" } fail validation before they reach a query.
 */

export const text = (max) => z.string().trim().min(1, "This field is required.").max(max, `Use ${max} characters or fewer.`);
export const optionalText = (max) => z.string().trim().max(max, `Use ${max} characters or fewer.`);

export const oneOf = (values) => z.enum(values, { message: "Choose one of the listed options." });
const optionalOneOf = (values) => z.union([oneOf(values), z.literal("")]);

// Numbers arrive from forms as strings or numbers. "" and null mean "not provided".
export const intInRange = (min, max) =>
  z.preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v),
    z.number({ message: "Enter a whole number." }).int("Enter a whole number.").min(min, `Enter ${min} or more.`).max(max, `Enter ${max} or less.`),
  );
const optionalInt = (min, max) =>
  z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), intInRange(min, max).optional());

const websitePattern = /^(https?:\/\/)?[^\s./]+(\.[^\s./]+)+(\/\S*)?$/i;
const handlePattern = /^[A-Za-z0-9._@/-]+$/;
const phonePattern = /^\+?[0-9][0-9\s()-]{6,18}$/;

export const emailSchema = z.string().trim().toLowerCase().max(254).email("Enter a valid email address.");
export const phoneSchema = z.string().trim().regex(phonePattern, "Enter a valid phone number.");
export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, "Use 72 bytes or fewer.")
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), "Include at least one letter and one number.");

const handle = z.union([z.string().trim().max(60).regex(handlePattern, "Use letters, numbers, dots or underscores, without spaces."), z.literal("")]);

/**
 * The profile fields. With defaults (registration) an omitted optional field becomes "".
 * Without defaults (updates) an omitted field stays omitted, so a PATCH can never blank fields it did not send.
 * (Zod 4 applies defaults even inside .partial(), which is why updates need their own shape.)
 */
function buildShape(withDefaults) {
  const d = (schema) => (withDefaults ? schema.default("") : schema);
  return {
  // Identity
  businessName: text(120),
  tradingName: d(optionalText(120)),
  businessType: oneOf(o.businessTypes),
  sector: oneOf(o.sectors),
  industry: text(120),
  yearEstablished: intInRange(1900, new Date().getFullYear()),
  hasCac: d(optionalOneOf(o.yesNo)),
  cacNumber: d(optionalText(30)),
  hasTin: d(optionalOneOf(o.yesNo)),
  tin: d(optionalText(30)),
  // Location
  state: oneOf(o.states),
  lga: text(80),
  city: text(80),
  address: text(200),
  // Ownership
  ownerName: text(100),
  ownerRole: oneOf(o.ownerRoles),
  ownershipStructure: oneOf(o.ownershipStructures),
  // Operations
  employees: intInRange(0, 100000),
  branches: optionalInt(0, 10000),
  // Financial
  annualRevenue: oneOf(o.annualRevenues),
  bankName: d(optionalText(80)),
  existingLoans: oneOf(o.existingLoans),
  fundingNeeds: d(optionalOneOf(o.fundingNeeds)),
  // Digital
  website: d(z.union([z.string().trim().max(120).regex(websitePattern, "Enter a valid website address."), z.literal("")])),
  facebook: d(handle),
  instagram: d(handle),
  x: d(handle),
  tiktok: d(handle),
  };
}

/** Every profile field name, in display order. The Yes or No answers are not counted as separate details. */
export const profileFieldNames = Object.keys(buildShape(true)).filter((name) => name !== "hasCac" && name !== "hasTin");

export const businessSchema = z.object(buildShape(true)).strict();

/** Partial update: only the fields sent are changed. Required fields cannot be blanked. */
export const businessPatchSchema = z.object(buildShape(false)).partial().strict();

/** Optional. Spaces are removed and letters capitalised before the check. */
export const referralCodeSchema = z
  .string()
  .trim()
  .max(30, "Enter a valid referral code.")
  .transform(normalizeReferralCode)
  .refine((v) => v === "" || /^[A-Z0-9-]{4,20}$/.test(v), "Enter a valid referral code.")
  .default("");

export const registerSchema = z
  .object({
    account: z
      .object({
        fullName: text(100),
        email: emailSchema,
        phone: phoneSchema,
        password: passwordSchema,
      })
      .strict(),
    business: businessSchema,
    acceptedTerms: z.literal(true, { message: "You must agree to the terms to continue." }),
    confirmedAccurate: z.literal(true, { message: "Please confirm the information is accurate." }),
    referralCode: referralCodeSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
  })
  .strict();

export const accountPatchSchema = z
  .object({ fullName: text(100).optional(), phone: phoneSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

/** Deleting an account asks for the password again, so a stolen session alone cannot do it. */
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(200) }).strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

/** The token from the link in an email. Random URL-safe text, so anything else is refused before it reaches a query. */
const emailTokenText = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "This link is invalid or has expired. Request a new one.");

export const resetPasswordSchema = z.object({ token: emailTokenText, newPassword: passwordSchema }).strict();

export const verifyEmailSchema = z.object({ token: emailTokenText }).strict();

export const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })
  .strict();

// ---------------------------------------------------------------------------
// Admin portal
// ---------------------------------------------------------------------------

const emailOrEmpty = z.union([emailSchema, z.literal("")]);

export const agentCreateSchema = z
  .object({
    fullName: text(100),
    phone: phoneSchema,
    email: emailOrEmpty.default(""),
    notes: optionalText(300).default(""),
  })
  .strict();

export const agentPatchSchema = z
  .object({
    fullName: text(100).optional(),
    phone: phoneSchema.optional(),
    email: emailOrEmpty.optional(),
    notes: optionalText(300).optional(),
    active: z.boolean({ message: "Choose active or inactive." }).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const adminCreateSchema = z.object({ fullName: text(100), email: emailSchema, phone: phoneSchema }).strict();

export const adminPatchSchema = z.object({ active: z.boolean({ message: "Choose active or inactive." }) }).strict();

export const statusChangeSchema = z
  .object({
    status: oneOf(o.verificationStatuses),
    note: text(200),
  })
  .strict();

/** Query strings: an empty value means "no filter". */
export const blankToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Not a valid id.");

export const businessListQuerySchema = z
  .object({
    page: z.preprocess(blankToUndefined, intInRange(1, 100000).optional()),
    q: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
    status: z.preprocess(blankToUndefined, oneOf(o.verificationStatuses).optional()),
    state: z.preprocess(blankToUndefined, oneOf(o.states).optional()),
    sector: z.preprocess(blankToUndefined, oneOf(o.sectors).optional()),
    agent: z.preprocess(blankToUndefined, objectId.optional()),
  })
  .strict();

export const pageQuerySchema = z
  .object({ page: z.preprocess(blankToUndefined, intInRange(1, 100000).optional()) })
  .strict();

export const idParamSchema = objectId;
