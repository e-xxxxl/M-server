import mongoose from "mongoose";
import { ApiError } from "../middleware/errors.js";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { notify } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { User } from "../models/User.js";
import { newCertificateCode, normalizeCertificateCode } from "./codes.js";
import { applyReview } from "./review.js";

/**
 * The training ecosystem (framework section 13): training, registration, attendance, assessment, completion and
 * certificate. A training is an Opportunity of type Training, so listing, eligibility, approval, applying and the
 * consent to share all work as they do for every other opportunity. Registration is an approved application.
 * This file adds what happens after approval: the plan with its sessions, attendance, the assessment, completion
 * and the certificate. Nothing here scores or ranks a participant.
 */

/** A participant is a business whose application to the training was approved, or has since been completed. */
export const participantStatuses = ["Approved", "Completed"];

const idOf = (value) => String(value);

/** A Training opportunity inside `scope` (a filter such as { organisation } for a partner, {} for NMREP), or a plain 404. */
export async function findTraining(scope, id) {
  const opportunity = await Opportunity.findOne({ ...scope, _id: id, type: "Training" });
  if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
  return opportunity;
}

/** The opportunity as staff see it, with the plan. */
export function opportunityView(opportunity) {
  const json = opportunity.toJSON();
  delete json.createdBy;
  return json;
}

/** Sessions the participant was marked present at. */
const attendedCount = (record, opportunity) => {
  const ids = new Set((opportunity.training?.sessions ?? []).map((s) => idOf(s._id)));
  return (record?.attendance ?? []).filter((a) => a.present && ids.has(idOf(a.session))).length;
};

/** What stands between a participant and completing the training, in plain words. Empty means ready. */
export function missingForCompletion(opportunity, record) {
  const missing = [];
  const need = opportunity.training?.minSessions ?? 0;
  const attended = attendedCount(record, opportunity);
  if (attended < need) missing.push(`Attended ${attended} of the ${need} sessions needed.`);
  if (opportunity.training?.requirePass && record?.assessment?.result !== "Passed") missing.push("The assessment has not been passed.");
  return missing;
}

async function recordFor(application) {
  return TrainingRecord.findOneAndUpdate(
    { application: application._id },
    { $setOnInsert: { opportunity: application.opportunity, business: application.business, owner: application.owner } },
    { upsert: true, returnDocument: "after" },
  );
}

/**
 * Who a participant is, as the viewer may see it. A partner sees only what the owner agreed to share when applying
 * (the business summary always, the owner's name only with the contact choice). Platform staff see both.
 */
async function identities(applications, scope) {
  const ids = applications.map((a) => a._id);
  const consents =
    scope === "partner"
      ? await ConsentRecord.find({ application: mongoose.trusted({ $in: ids }), revokedAt: null }).sort({ grantedAt: -1 })
      : [];
  const consentOf = new Map();
  for (const c of consents) if (!consentOf.has(idOf(c.application))) consentOf.set(idOf(c.application), c);
  const users = new Map((await User.find({ _id: mongoose.trusted({ $in: applications.map((a) => a.owner) }) }).select("fullName")).map((u) => [idOf(u._id), u]));
  const result = new Map();
  for (const a of applications) {
    if (scope === "partner") {
      const consent = consentOf.get(idOf(a._id));
      result.set(idOf(a._id), {
        businessName: consent && a.snapshot ? a.snapshot.businessName : null,
        ownerName: consent?.categories.includes("contact") ? (users.get(idOf(a.owner))?.fullName ?? null) : null,
      });
    } else {
      result.set(idOf(a._id), { businessName: a.snapshot?.businessName ?? null, ownerName: users.get(idOf(a.owner))?.fullName ?? null });
    }
  }
  return result;
}

/** Every participant of a training with attendance, assessment and what is left to complete. */
export async function participantsOf(opportunity, scope) {
  const applications = await Application.find({ opportunity: opportunity._id, status: mongoose.trusted({ $in: participantStatuses }) }).sort({ updatedAt: -1 });
  const [who, records] = await Promise.all([
    identities(applications, scope),
    TrainingRecord.find({ application: mongoose.trusted({ $in: applications.map((a) => a._id) }) }),
  ]);
  const recordOf = new Map(records.map((r) => [idOf(r.application), r]));
  return applications.map((a) => {
    const record = recordOf.get(idOf(a._id));
    const attendance = {};
    for (const x of record?.attendance ?? []) attendance[idOf(x.session)] = x.present;
    return {
      applicationId: idOf(a._id),
      status: a.status,
      ...who.get(idOf(a._id)),
      attendance,
      attended: attendedCount(record, opportunity),
      assessment: record?.assessment?.result ? { result: record.assessment.result, score: record.assessment.score, note: record.assessment.note, at: record.assessment.at } : null,
      completedAt: record?.completedAt ?? null,
      certificateCode: record?.certificate?.code ?? null,
      missing: a.status === "Approved" ? missingForCompletion(opportunity, record) : [],
    };
  });
}

/** The Training opportunities in scope with how many participants each has. */
export async function trainingList(scope) {
  const items = await Opportunity.find({ ...scope, type: "Training" }).sort({ createdAt: -1 }).limit(200);
  const rows = await Application.aggregate([
    { $match: { opportunity: { $in: items.map((o) => o._id) }, status: { $in: participantStatuses } } },
    { $group: { _id: { opportunity: "$opportunity", status: "$status" }, count: { $sum: 1 } } },
  ]);
  const counts = new Map();
  for (const r of rows) {
    const c = counts.get(idOf(r._id.opportunity)) ?? { Approved: 0, Completed: 0 };
    c[r._id.status] = r.count;
    counts.set(idOf(r._id.opportunity), c);
  }
  return items.map((o) => {
    const c = counts.get(idOf(o._id)) ?? { Approved: 0, Completed: 0 };
    return { ...opportunityView(o), participants: c.Approved + c.Completed, completed: c.Completed };
  });
}

/** Replaces the plan. Sessions that carry an id are kept; one that has attendance marked cannot be removed. */
export async function savePlan(opportunity, plan) {
  const existing = new Map((opportunity.training?.sessions ?? []).map((s) => [idOf(s._id), s]));
  const sessions = [];
  const keep = new Set();
  for (const [i, s] of plan.sessions.entries()) {
    if (s.id) {
      if (!existing.has(s.id)) throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`sessions.${i}.id`]: "This session does not exist." });
      keep.add(s.id);
      sessions.push({ _id: s.id, title: s.title, on: s.on });
    } else {
      sessions.push({ title: s.title, on: s.on });
    }
  }
  const removed = [...existing.keys()].filter((id) => !keep.has(id));
  if (removed.length > 0) {
    const used = await TrainingRecord.exists({ opportunity: opportunity._id, "attendance.session": mongoose.trusted({ $in: removed }) });
    if (used) throw new ApiError(409, "session_in_use", "A session that already has attendance marked cannot be removed.");
  }
  sessions.sort((a, b) => a.on - b.on);
  opportunity.training = { mode: plan.mode, venue: plan.venue, startsOn: plan.startsOn, endsOn: plan.endsOn, sessions, minSessions: plan.minSessions, requirePass: plan.requirePass };
  await opportunity.save();
}

/** Loads the approved or completed applications named in a request, or fails with a field message for the first that is not. */
async function participantApplications(opportunity, applicationIds, pathFor) {
  const rows = await Application.find({ _id: mongoose.trusted({ $in: applicationIds }), opportunity: opportunity._id, status: mongoose.trusted({ $in: participantStatuses }) });
  const found = new Map(rows.map((a) => [idOf(a._id), a]));
  for (const [i, id] of applicationIds.entries()) {
    if (!found.has(id)) throw new ApiError(422, "validation", "Please check the highlighted fields.", { [pathFor(i)]: "This participant is not part of this training." });
  }
  return found;
}

const notEditable = () => new ApiError(409, "already_completed", "This participant has completed the training, so the record can no longer be changed.");

/** Marks present or absent for a session. Marking again replaces the earlier mark. */
export async function markAttendance(opportunity, { sessionId, marks }) {
  if (!(opportunity.training?.sessions ?? []).some((s) => idOf(s._id) === sessionId)) {
    throw new ApiError(422, "validation", "Please check the highlighted fields.", { sessionId: "Choose one of this training's sessions." });
  }
  const applications = await participantApplications(opportunity, marks.map((m) => m.applicationId), (i) => `marks.${i}.applicationId`);
  for (const a of applications.values()) if (a.status === "Completed") throw notEditable();
  for (const m of marks) {
    const record = await recordFor(applications.get(m.applicationId));
    const entry = record.attendance.find((x) => idOf(x.session) === sessionId);
    if (entry) {
      entry.present = m.present;
      entry.at = new Date();
    } else {
      record.attendance.push({ session: sessionId, present: m.present });
    }
    await record.save();
  }
}

export async function recordAssessment(opportunity, { applicationId, result, score, note }) {
  const applications = await participantApplications(opportunity, [applicationId], () => "applicationId");
  const application = applications.get(applicationId);
  if (application.status === "Completed") throw notEditable();
  const record = await recordFor(application);
  record.assessment = { result, score, note, at: new Date() };
  await record.save();
}

/** A new code, retried in the very unlikely event that it already exists. */
async function freshCode() {
  for (let i = 0; i < 5; i += 1) {
    const code = newCertificateCode();
    if (!(await TrainingRecord.exists({ "certificate.code": code }))) return code;
  }
  throw new ApiError(500, "server_error", "Could not create a certificate code. Please try again.");
}

/** Completes the training for one participant and issues the certificate. */
export async function completeParticipant(opportunity, applicationId, note, actor) {
  const application = await Application.findOne({ _id: applicationId, opportunity: opportunity._id, status: mongoose.trusted({ $in: participantStatuses }) });
  if (!application) throw new ApiError(404, "not_found", "Not found.");
  if (application.status === "Completed") throw new ApiError(409, "already_completed", "This participant has already completed the training.");
  const record = await recordFor(application);
  const missing = missingForCompletion(opportunity, record);
  if (missing.length > 0) throw new ApiError(422, "not_ready", `This participant cannot complete the training yet. ${missing.join(" ")}`, { _: missing.join(" ") });

  record.completedAt = new Date();
  record.certificate = { code: await freshCode(), issuedAt: record.completedAt };
  await record.save();
  await applyReview(application, "Completed", note || "Training completed.", actor);
  await notify(application.owner, {
    type: "application",
    title: `Your certificate is ready: ${opportunity.title}`.slice(0, 120),
    body: `Certificate ${record.certificate.code}.`,
    link: "/dashboard/training/",
  });
  return record;
}

// ------------------------------------------------------------------ the owner

/** The owner's own trainings: where they are registered, what they attended, the assessment and the certificate. */
export async function ownerTrainings(ownerId) {
  const applications = await Application.find({ owner: ownerId, status: mongoose.trusted({ $in: participantStatuses }) }).sort({ updatedAt: -1 });
  const opportunities = new Map(
    (await Opportunity.find({ _id: mongoose.trusted({ $in: applications.map((a) => a.opportunity) }), type: "Training" })).map((o) => [idOf(o._id), o]),
  );
  const records = new Map((await TrainingRecord.find({ owner: ownerId })).map((r) => [idOf(r.application), r]));
  const items = [];
  for (const a of applications) {
    const o = opportunities.get(idOf(a.opportunity));
    if (!o) continue;
    const record = records.get(idOf(a._id));
    const marks = new Map((record?.attendance ?? []).map((x) => [idOf(x.session), x.present]));
    const t = o.training;
    items.push({
      applicationId: idOf(a._id),
      opportunityId: idOf(o._id),
      title: o.title,
      provider: o.provider,
      status: a.status,
      mode: t?.mode ?? null,
      venue: t?.venue ?? "",
      startsOn: t?.startsOn ?? null,
      endsOn: t?.endsOn ?? null,
      sessions: (t?.sessions ?? []).map((s) => ({ id: idOf(s._id), title: s.title, on: s.on, present: marks.has(idOf(s._id)) ? marks.get(idOf(s._id)) : null })),
      attended: attendedCount(record, o),
      minSessions: t?.minSessions ?? 0,
      requirePass: t?.requirePass ?? false,
      assessment: record?.assessment?.result ? { result: record.assessment.result, score: record.assessment.score, note: record.assessment.note } : null,
      completedAt: record?.completedAt ?? null,
      certificate: record?.certificate?.code ? { code: record.certificate.code, issuedAt: record.certificate.issuedAt } : null,
    });
  }
  return items;
}

/** What anyone with a certificate code may check: who it was issued to, for what, by whom and when. Nothing else. */
export async function certificateByCode(value) {
  const record = await TrainingRecord.findOne({ "certificate.code": normalizeCertificateCode(value) });
  if (!record) return null;
  const [application, opportunity, owner] = await Promise.all([Application.findById(record.application), Opportunity.findById(record.opportunity), User.findById(record.owner).select("fullName")]);
  if (!opportunity || !owner) return null;
  const business = application?.snapshot?.businessName ?? (await Business.findOne({ owner: record.owner }).select("businessName"))?.businessName ?? "";
  return {
    code: record.certificate.code,
    holderName: owner.fullName,
    businessName: business,
    training: opportunity.title,
    provider: opportunity.provider,
    mode: opportunity.training?.mode ?? null,
    issuedAt: record.certificate.issuedAt,
    completedOn: record.completedAt,
  };
}
