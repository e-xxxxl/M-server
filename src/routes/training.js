import { Router } from "express";
import { audit } from "../models/AuditLog.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { normalizeCertificateCode } from "../lib/codes.js";
import {
  certificateByCode,
  completeParticipant,
  findTraining,
  markAttendance,
  opportunityView,
  ownerTrainings,
  participantsOf,
  recordAssessment,
  savePlan,
  trainingList,
} from "../lib/training.js";
import { idParamSchema } from "../schemas.js";
import { assessmentSchema, attendanceSchema, completeSchema, trainingPlanSchema } from "../schemas-opportunities.js";

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

/**
 * Running a training: its plan, attendance, assessments and completion. The same routes serve a training provider
 * (limited to its own organisation's trainings, and to what each participant agreed to share) and NMREP staff
 * (every training, all participants). `scope(req)` is the filter on opportunities and `viewer` is "partner" or "admin".
 * The caller has already checked the role.
 */
export function trainingStaffRoutes({ scope, viewer }) {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ items: await trainingList(scope(req)) });
  });

  router.get("/:id", async (req, res) => {
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    res.json({ opportunity: opportunityView(opportunity), participants: await participantsOf(opportunity, viewer) });
  });

  router.put("/:id/plan", async (req, res) => {
    const plan = trainingPlanSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await savePlan(opportunity, plan);
    await audit(req.user, "training.plan", `Updated the plan of "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.json({ opportunity: opportunityView(opportunity) });
  });

  router.post("/:id/attendance", async (req, res) => {
    const input = attendanceSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await markAttendance(opportunity, input);
    res.json({ participants: await participantsOf(opportunity, viewer) });
  });

  router.post("/:id/assessment", async (req, res) => {
    const input = assessmentSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await recordAssessment(opportunity, input);
    await audit(req.user, "training.assessment", `Recorded an assessment for "${opportunity.title}"`, { type: "application", id: input.applicationId });
    res.json({ participants: await participantsOf(opportunity, viewer) });
  });

  router.post("/:id/participants/:applicationId/complete", async (req, res) => {
    const { note } = completeSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await completeParticipant(opportunity, parseId(req.params.applicationId), note, req.user);
    res.json({ participants: await participantsOf(opportunity, viewer) });
  });

  return router;
}

/** The business owner's own trainings and certificates. */
export function trainingOwnerRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"));
  router.get("/", async (req, res) => {
    res.json({ items: await ownerTrainings(req.user._id) });
  });
  return router;
}

/** Checking a certificate needs no account. The code is the secret, and it is long enough that it cannot be guessed. */
export function certificateRoutes({ limiter }) {
  const router = Router();
  router.get("/:code", limiter, async (req, res) => {
    const code = normalizeCertificateCode(req.params.code);
    const certificate = /^NMC-[A-Z2-9]{10}$/.test(code) ? await certificateByCode(code) : null;
    if (!certificate) throw new ApiError(404, "not_found", "No certificate has this code.");
    res.json({ certificate });
  });
  return router;
}
