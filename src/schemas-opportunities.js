import { z } from "zod";
import { criterionKinds } from "./lib/eligibility.js";
import {
  adminSettableStatuses,
  applicationStatuses,
  assessmentResults,
  trainingModes,
  criterionLevels,
  organisationTypesAvailable,
  opportunityTypes,
  reviewableStatuses,
} from "./lib/opportunity-constants.js";
import { blankToUndefined, emailSchema, intInRange, objectId, oneOf, optionalText, phoneSchema, text } from "./schemas.js";

/** Validation for opportunities, applications and notifications. Every schema is strict. */

const intOpt = (max) =>
  z.number({ message: "Enter a whole number." }).int("Enter a whole number.").min(0, "Enter 0 or more.").max(max, `Enter ${max} or less.`);

/** One requirement. The fields needed by its kind are checked and anything irrelevant is dropped. */
const criterionSchema = z
  .object({
    key: oneOf(Object.keys(criterionKinds)),
    level: oneOf(criterionLevels),
    values: z.array(z.string().max(100)).max(40).optional(),
    min: intOpt(100000).optional(),
    max: intOpt(100000).optional(),
  })
  .strict()
  .transform((c, ctx) => {
    const spec = criterionKinds[c.key];
    const fail = (path, message) => ctx.addIssue({ code: "custom", path: [path], message });
    if (spec.kind === "set") {
      const values = [...new Set(c.values ?? [])];
      if (values.length === 0) fail("values", "Choose at least one option.");
      else if (values.some((v) => !spec.options.includes(v))) fail("values", "Choose from the listed options.");
      return { key: c.key, level: c.level, values };
    }
    if (spec.kind === "min") {
      if (c.min === undefined) fail("min", "Enter the minimum.");
      else if (c.min > spec.max) fail("min", `Enter ${spec.max} or less.`);
      return { key: c.key, level: c.level, min: c.min };
    }
    if (spec.kind === "range") {
      if (c.min === undefined && c.max === undefined) fail("min", "Enter a minimum, a maximum, or both.");
      else if (c.min !== undefined && c.max !== undefined && c.min > c.max) fail("max", "The maximum must not be below the minimum.");
      const out = { key: c.key, level: c.level };
      if (c.min !== undefined) out.min = c.min;
      if (c.max !== undefined) out.max = c.max;
      return out;
    }
    return { key: c.key, level: c.level }; // "yes" and "verified" need nothing more
  });

const criteriaList = z
  .array(criterionSchema)
  .max(20, "Use 20 requirements or fewer.")
  .refine((list) => new Set(list.map((c) => c.key)).size === list.length, "Each requirement can be added only once.");

/** A date such as 2027-01-31, kept as the end of that day in Nigeria (23:59 West Africa Time, which is 22:59 UTC). Empty or null means no deadline. */
const deadlineSchema = z.union([
  z.literal("").transform(() => null),
  z.null(),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
    .transform((v, ctx) => {
      const d = new Date(`${v}T22:59:59.000Z`);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: "Enter a valid date." });
        return null;
      }
      return d;
    }),
]);

/** The first day applications are accepted, from midnight at the start of that day in Nigeria. Empty means no start date. */
const opensOnSchema = z.union([
  z.literal("").transform(() => null),
  z.null(),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
    .transform((v, ctx) => {
      const d = new Date(`${v}T00:00:00.000+01:00`);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: "Enter a valid date." });
        return null;
      }
      return d;
    }),
]);

/** How many applications can be approved. Empty means no limit. */
const limitSchema = z.union([z.literal("").transform(() => null), z.null(), intInRange(1, 1000000)]);

const shape = {
  title: text(120),
  provider: text(120),
  type: oneOf(opportunityTypes),
  description: text(4000),
  deadline: deadlineSchema,
  opensOn: opensOnSchema,
  beneficiaryLimit: limitSchema,
  criteria: criteriaList,
};

const optionalDefaults = { deadline: deadlineSchema.default(null), opensOn: opensOnSchema.default(null), beneficiaryLimit: limitSchema.default(null), criteria: criteriaList.default([]) };

/** Platform admins write the provider name themselves. */
export const opportunityCreateSchema = z.object({ ...shape, ...optionalDefaults }).strict();

export const opportunityPatchSchema = z
  .object({ ...shape, status: oneOf(adminSettableStatuses) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

/** A partner's opportunity: the provider is always the organisation, and it cannot set its own status. */
const partnerShape = Object.fromEntries(Object.entries(shape).filter(([key]) => key !== "provider"));
export const partnerOpportunityCreateSchema = z.object({ ...partnerShape, ...optionalDefaults }).strict();
export const partnerOpportunityPatchSchema = z
  .object(partnerShape)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const returnSchema = z.object({ note: text(200) }).strict();

// ---------------------------------------------------------------------------
// Organisations and their people
// ---------------------------------------------------------------------------

export const organisationCreateSchema = z
  .object({
    name: text(120),
    type: oneOf(organisationTypesAvailable),
    description: optionalText(500).default(""),
  })
  .strict();

export const organisationPatchSchema = z
  .object({
    name: text(120).optional(),
    type: oneOf(organisationTypesAvailable).optional(),
    description: optionalText(500).optional(),
    active: z.boolean({ message: "Choose active or inactive." }).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const partnerUserCreateSchema = z.object({ fullName: text(100), email: emailSchema, phone: phoneSchema }).strict();
export const partnerUserPatchSchema = z.object({ active: z.boolean({ message: "Choose active or inactive." }) }).strict();

/** What the owner agrees to share with the organisation. The summary is needed to submit. */
const consentSchema = z
  .object({
    summary: z.boolean().default(false),
    contact: z.boolean().default(false),
    profile: z.boolean().default(false),
    documents: z.boolean().default(false),
  })
  .strict();

export const applicationSaveSchema = z
  .object({
    opportunityId: objectId,
    message: optionalText(500).default(""),
    submit: z.boolean().default(false),
    consent: consentSchema.optional(),
    // Documents from the wallet to attach when submitting. Needs consent.documents.
    documentIds: z.array(objectId).max(10, "Attach 10 documents or fewer.").default([]),
  })
  .strict();

export const applicationStatusSchema = z.object({ status: oneOf(applicationStatuses), note: text(200) }).strict();

export const opportunityQuerySchema = z.object({ type: z.preprocess(blankToUndefined, oneOf(opportunityTypes).optional()) }).strict();

export const applicationListQuerySchema = z
  .object({
    page: z.preprocess(blankToUndefined, intInRange(1, 100000).optional()),
    status: z.preprocess(blankToUndefined, oneOf(reviewableStatuses).optional()),
    opportunity: z.preprocess(blankToUndefined, objectId.optional()),
    organisation: z.preprocess(blankToUndefined, objectId.optional()),
  })
  .strict();

export const opportunityListQuerySchema = z
  .object({ status: z.preprocess(blankToUndefined, oneOf(["Draft", "Pending Approval", "Open", "Closed"]).optional()) })
  .strict();

export const notificationReadSchema = z.object({ ids: z.array(objectId).max(100).optional() }).strict();

// ---------------------------------------------------------------------------
// Training: the plan, attendance, assessment and completion
// ---------------------------------------------------------------------------

/** A session day such as 2027-03-15, kept as the start of that day in Nigeria. */
const dayRequired = z
  .string({ message: "This field is required." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD.")
  .transform((v, ctx) => {
    const d = new Date(`${v}T00:00:00.000+01:00`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date." });
      return null;
    }
    return d;
  });

const sessionInputSchema = z.object({ id: objectId.optional(), title: text(100), on: dayRequired }).strict();

/** The whole plan, sent as one piece. Sessions that carry an id are kept (and renamed or moved); the others are new. */
export const trainingPlanSchema = z
  .object({
    mode: oneOf(trainingModes),
    venue: optionalText(200).default(""),
    startsOn: opensOnSchema.default(null),
    endsOn: opensOnSchema.default(null),
    sessions: z.array(sessionInputSchema).max(60, "Use 60 sessions or fewer.").default([]),
    minSessions: intInRange(0, 60).default(0),
    requirePass: z.boolean({ message: "Choose yes or no." }).default(false),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.startsOn && plan.endsOn && plan.endsOn < plan.startsOn) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "The end date must not be before the start date." });
    }
    if (plan.minSessions > plan.sessions.length) {
      ctx.addIssue({ code: "custom", path: ["minSessions"], message: "This cannot be more than the number of sessions." });
    }
  });

export const attendanceSchema = z
  .object({
    sessionId: objectId,
    marks: z.array(z.object({ applicationId: objectId, present: z.boolean({ message: "Choose present or absent." }) }).strict()).min(1, "Mark at least one participant.").max(500, "Mark 500 participants or fewer."),
  })
  .strict();

const scoreSchema = z.union([z.literal("").transform(() => null), z.null(), intInRange(0, 100)]);

export const assessmentSchema = z
  .object({ applicationId: objectId, result: oneOf(assessmentResults), score: scoreSchema.default(null), note: optionalText(200).default("") })
  .strict();

export const completeSchema = z.object({ note: optionalText(200).default("") }).strict();
