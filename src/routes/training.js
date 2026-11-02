import { Router } from "express";
import { audit } from "../models/AuditLog.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { normalizeCertificateCode } from "../lib/codes.js";
import { toCsv } from "../lib/csv.js";
import {
  certificateByCode,
  completeParticipant,
  findTraining,
  markAttendance,
  opportunityView,
  ownerTrainings,
  participantRows,
  participantsOf,
  recordAssessment,
  reissueCertificate,
  revokeCertificate,
  savePlan,
  trainingList,
} from "../lib/training.js";
import { idParamSchema } from "../schemas.js";
import { assessmentSchema, attendanceSchema, completeSchema, reissueCertificateSchema, revokeCertificateSchema, trainingPlanSchema } from "../schemas-opportunities.js";

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

  router.post("/:id/participants/:applicationId/certificate/revoke", async (req, res) => {
    const { reason } = revokeCertificateSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await revokeCertificate(opportunity, parseId(req.params.applicationId), reason, req.user);
    await audit(req.user, "training.certificate.revoke", `Withdrew a certificate for "${opportunity.title}" (${reason})`.slice(0, 300), { type: "application", id: req.params.applicationId });
    res.json({ participants: await participantsOf(opportunity, viewer) });
  });

  router.post("/:id/participants/:applicationId/certificate/reissue", async (req, res) => {
    const { reason } = reissueCertificateSchema.parse(req.body);
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    await reissueCertificate(opportunity, parseId(req.params.applicationId), reason, req.user);
    await audit(req.user, "training.certificate.reissue", `Issued a new certificate for "${opportunity.title}"${reason ? ` (${reason})` : ""}`.slice(0, 300), { type: "application", id: req.params.applicationId });
    res.json({ participants: await participantsOf(opportunity, viewer) });
  });

  // The participants as a spreadsheet. A training provider gets only what each owner agreed to share, like the screen.
  router.get("/:id/participants.csv", async (req, res) => {
    const opportunity = await findTraining(scope(req), parseId(req.params.id));
    const { sessions, people } = await participantRows(opportunity, viewer);
    const mark = (p, s) => (String(s._id) in p.attendance ? (p.attendance[String(s._id)] ? "Present" : "Absent") : "Not recorded");
    const csv = toCsv(
      [
        { header: "Business", value: (p) => p.businessName ?? "Not shared" },
        { header: "Owner", value: (p) => p.ownerName ?? "Not shared" },
        { header: "Status", value: (p) => p.status },
        ...sessions.map((s) => ({ header: `Session: ${s.title}`, value: (p) => mark(p, s) })),
        { header: "Sessions attended", value: (p) => p.attended },
        { header: "Assessment", value: (p) => p.assessment?.result ?? "" },
        { header: "Score", value: (p) => p.assessment?.score ?? "" },
        { header: "Completed on", value: (p) => (p.completedAt ? new Date(p.completedAt).toISOString().slice(0, 10) : "") },
        { header: "Certificate", value: (p) => p.certificateCode ?? (p.certificateWithdrawnOn ? "Withdrawn" : "") },
      ],
      people,
    );
    await audit(req.user, "training.export", `Exported the participants of "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="training-participants.csv"');
    res.setHeader("Cache-Control", "no-store");
    res.send(csv);
  });

  return router;
}

/** The business owner's own trainings and certificates. */
export function trainingOwnerRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));
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
