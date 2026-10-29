import { Router } from "express";
import mongoose from "mongoose";
import { compareFit, evaluate } from "../lib/eligibility.js";
import { openOpportunitiesFor, organisationActive } from "../lib/open-opportunities.js";
import { editable, withdrawable } from "../lib/opportunity-constants.js";
import { categoryKeys, describeSharing, sharingCategories } from "../lib/sharing.js";
import { profileFieldNames, idParamSchema } from "../schemas.js";
import { applicationSaveSchema, notificationReadSchema, opportunityQuerySchema } from "../schemas-opportunities.js";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { Document } from "../models/Document.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Notification } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";

/** A malformed id is simply "not found". */
function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

/** An opportunity as owners see it: without the internal id of the person who created it. */
const publicOpportunity = (opportunity) => {
  const json = opportunity.toJSON();
  delete json.createdBy;
  delete json.organisation;
  delete json.archivedAt; // an admin's housekeeping, not for owners
  return json;
};

const fitSummary = (fit) => ({ label: fit.label, met: fit.met, total: fit.total, requiredMissing: fit.requiredMissing });

/** A copy of the profile as it is at submission. It never includes referral data. */
function snapshotOf(business) {
  const json = business.toJSON();
  const snapshot = {};
  for (const name of [...profileFieldNames, "hasCac", "hasTin", "verificationStatus", "nmrepId"]) snapshot[name] = json[name] ?? null;
  return snapshot;
}

/** The organisation behind an opportunity, or null when NMREP runs it. */
async function organisationOf(opportunity) {
  return opportunity.organisation ? Organisation.findById(opportunity.organisation).select("name active").lean() : null;
}

/** What owners can do with opportunities, their applications, their consents and their notifications. */
export function opportunityRoutes({ config }) {
  const opportunities = Router();
  const applications = Router();
  const notifications = Router();
  const consents = Router();
  for (const r of [opportunities, applications, consents]) r.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));
  // Notifications stay open to an owner who has not paid yet, so they can read the message about the fee.
  notifications.use(requireAuth(config), requireRole("msme_owner"));

  const ownBusiness = async (req) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    return business;
  };

  // ------------------------------------------------------------ opportunities
  opportunities.get("/", async (req, res) => {
    const { type, tag } = opportunityQuerySchema.parse(req.query);
    const business = await ownBusiness(req);
    const found = await openOpportunitiesFor(business, req.user._id, { filter: { ...(type ? { type } : {}), ...(tag ? { tags: tag } : {}) } });
    const items = found
      .map(({ opportunity: o, organisationName, fit, applicationStatus }) => ({
        id: String(o._id),
        title: o.title,
        provider: o.provider,
        organisationName,
        summary: o.description.replace(/\s+/g, " ").trim().slice(0, 160),
        type: o.type,
        tags: o.tags,
        deadline: o.deadline,
        fit,
        applicationStatus,
      }))
      .sort(compareFit)
      .map((o) => ({ ...o, fit: fitSummary(o.fit) }));
    res.json({ items });
  });

  opportunities.get("/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const opportunity = await Opportunity.findById(id);
    const application = await Application.findOne({ opportunity: id, owner: req.user._id });
    // Drafts and ones waiting for approval are never shown. A closed opportunity is shown only to someone who already applied.
    if (!opportunity || ["Draft", "Pending Approval"].includes(opportunity.status) || (opportunity.status !== "Open" && !application)) {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const org = await organisationOf(opportunity);
    if (!organisationActive(org) && !application) throw new ApiError(404, "not_found", "Not found.");
    const business = await ownBusiness(req);
    // Which of the documents this opportunity asks for are already in the owner's wallet.
    const inWallet = new Set(await Document.distinct("kind", { owner: req.user._id }));
    res.json({
      opportunity: { ...publicOpportunity(opportunity), organisationName: org?.name ?? null },
      documentsNeeded: (opportunity.requiredDocuments ?? []).map((kind) => ({ kind, inWallet: inWallet.has(kind) })),
      fit: evaluate(opportunity.criteria, business),
      acceptingApplications: opportunity.isAcceptingApplications() && organisationActive(org),
      // What the owner would be agreeing to share if they apply.
      sharing: describeSharing(org?.name ?? null),
      application: application ? application.toJSON() : null,
    });
  });

  // ------------------------------------------------------------- applications
  applications.get("/", async (req, res) => {
    const list = await Application.find({ owner: req.user._id }).sort({ updatedAt: -1 }).limit(200);
    const titles = new Map(
      (await Opportunity.find({ _id: mongoose.trusted({ $in: list.map((a) => a.opportunity) }) }).select("title provider type")).map((o) => [String(o._id), o]),
    );
    res.json({
      items: list.map((a) => {
        const o = titles.get(String(a.opportunity));
        return {
          id: String(a._id),
          opportunityId: String(a.opportunity),
          opportunityTitle: o?.title ?? "Opportunity removed",
          provider: o?.provider ?? "",
          type: o?.type ?? "",
          status: a.status,
          submittedAt: a.submittedAt,
          updatedAt: a.updatedAt,
        };
      }),
    });
  });

  // Save a draft, or save and submit. Needs an open opportunity, a business that meets every required requirement,
  // and (to submit) the owner's agreement to share their business summary with the organisation.
  applications.post("/", async (req, res) => {
    const { opportunityId, message, submit, consent, documentIds, answers } = applicationSaveSchema.parse(req.body);
    const opportunity = await Opportunity.findById(opportunityId);
    if (!opportunity || ["Draft", "Pending Approval"].includes(opportunity.status)) throw new ApiError(404, "not_found", "Not found.");
    const org = await organisationOf(opportunity);
    if (!opportunity.isAcceptingApplications() || !organisationActive(org)) {
      throw new ApiError(422, "closed", "This opportunity is not accepting applications.");
    }
    const business = await ownBusiness(req);
    let application = await Application.findOne({ opportunity: opportunity._id, business: business._id });
    // A submitted application is final for the owner (except to answer a request for more information),
    // whatever has changed in their profile since.
    if (application && !editable.includes(application.status)) {
      throw new ApiError(409, "already_submitted", "This application has already been submitted.");
    }
    if (evaluate(opportunity.criteria, business).label !== "Eligible") {
      throw new ApiError(422, "not_eligible", "Your business does not meet every required requirement for this opportunity.");
    }
    if (submit && !consent?.summary) {
      throw new ApiError(422, "consent_required", "Please agree to share your business summary to apply.", {
        "consent.summary": `Agree to share your business summary with ${org?.name ?? "NMREP"} to apply.`,
      });
    }

    // Answers to the organisation's questions. A draft may be partly answered; a submission needs every required one.
    const questions = opportunity.questions ?? [];
    const given = new Map();
    if (answers === undefined) {
      for (const a of application?.answers ?? []) given.set(String(a.question), a.answer);
    } else {
      answers.forEach((a, i) => {
        if (!questions.some((q) => String(q._id) === a.questionId)) {
          throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`answers.${i}.questionId`]: "This question is not part of the opportunity." });
        }
        given.set(a.questionId, a.answer);
      });
    }
    if (submit) {
      const unanswered = {};
      questions.forEach((q, i) => {
        if (q.required && !(given.get(String(q._id)) ?? "").trim()) unanswered[`answers.${i}`] = "Answer this question.";
      });
      if (Object.keys(unanswered).length > 0) throw new ApiError(422, "validation", "Please answer the required questions.", unanswered);
    }
    const answerList = questions
      .map((q) => ({ question: q._id, text: q.text, answer: (given.get(String(q._id)) ?? "").trim() }))
      .filter((a) => a.answer !== "");

    // Documents are attached only when submitting, only with the owner's agreement, and only from their own wallet.
    const attach = submit ? [...new Set(documentIds)] : [];
    if (submit) {
      if (attach.length > 0 && !consent?.documents) {
        throw new ApiError(422, "consent_required", "Please agree to share your documents to attach them.", {
          "consent.documents": `Tick "Documents you choose" to share these documents with ${org?.name ?? "NMREP"}.`,
        });
      }
      if (consent?.documents && attach.length === 0) {
        throw new ApiError(422, "validation", "Please check the highlighted fields.", { documentIds: "Choose at least one document to share, or untick the box." });
      }
      if (attach.length > 0) {
        const owned = new Set((await Document.find({ _id: mongoose.trusted({ $in: attach }), owner: req.user._id }).select("_id")).map((d) => String(d._id)));
        const missing = attach.findIndex((id) => !owned.has(id));
        if (missing >= 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`documentIds.${missing}`]: "This document is not in your wallet." });
      }
      // The kinds of document this opportunity asks for must be among the ones attached.
      if ((opportunity.requiredDocuments ?? []).length > 0) {
        const attachedKinds = new Set(attach.length ? (await Document.find({ _id: mongoose.trusted({ $in: attach }), owner: req.user._id }).select("kind")).map((d) => d.kind) : []);
        const lacking = opportunity.requiredDocuments.filter((k) => !attachedKinds.has(k));
        if (lacking.length > 0) {
          throw new ApiError(422, "documents_required", `This opportunity needs these documents: ${lacking.join(", ")}. Add them to your wallet and attach them.`, {
            documentIds: `Attach: ${lacking.join(", ")}.`,
          });
        }
      }
    }

    const answering = application?.status === "More Information Required";
    if (!application) {
      application = new Application({
        opportunity: opportunity._id,
        business: business._id,
        owner: req.user._id,
        history: [{ status: "Draft", note: "Draft saved" }],
      });
    } else if (application.status === "Withdrawn" && !submit) {
      application.status = "Draft";
      application.history.push({ status: "Draft", note: "Reopened as a draft" });
    }

    application.message = message;
    application.answers = answerList;
    if (submit) {
      application.status = "Submitted";
      application.submittedAt = answering ? application.submittedAt : new Date();
      application.snapshot = snapshotOf(business);
      application.documents = attach;
      application.history.push({ status: "Submitted", note: answering ? "The applicant answered the request for more information" : "Submitted by the applicant" });
    }
    try {
      await application.save();
    } catch (err) {
      if (err?.code === 11000) throw new ApiError(409, "already_exists", "You already have an application for this opportunity.");
      throw err;
    }

    if (submit) {
      // The record of what was shared, with whom, why and when. An earlier agreement for this application is ended first.
      await ConsentRecord.updateMany(
        { application: application._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "Replaced by a new submission" } },
      );
      await ConsentRecord.create({
        owner: req.user._id,
        business: business._id,
        application: application._id,
        opportunity: opportunity._id,
        organisation: opportunity.organisation ?? null,
        sharedWith: org?.name ?? "NMREP",
        purpose: `Application for "${opportunity.title}"`.slice(0, 200),
        categories: categoryKeys.filter((k) => consent[k] === true),
        documents: attach,
      });
    }
    res.status(201).json({ application: application.toJSON() });
  });

  applications.get("/:id", async (req, res) => {
    const application = await Application.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!application) throw new ApiError(404, "not_found", "Not found.");
    res.json({ application: application.toJSON() });
  });

  applications.post("/:id/withdraw", async (req, res) => {
    const application = await Application.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!application) throw new ApiError(404, "not_found", "Not found.");
    if (!withdrawable.includes(application.status)) {
      throw new ApiError(409, "cannot_withdraw", "This application can no longer be withdrawn.");
    }
    application.status = "Withdrawn";
    application.history.push({ status: "Withdrawn", note: "Withdrawn by the applicant" });
    await application.save();
    // Withdrawing ends the sharing: the organisation can no longer see the applicant's details.
    await ConsentRecord.updateMany({ application: application._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: "Application withdrawn" } });
    res.json({ application: application.toJSON() });
  });

  // ----------------------------------------------------------------- consents
  consents.get("/", async (req, res) => {
    const rows = await ConsentRecord.find({ owner: req.user._id }).sort({ grantedAt: -1 }).limit(200);
    res.json({
      items: rows.map((c) => ({
        ...c.toJSON(),
        categoryDetails: c.categories.map((k) => ({ key: k, label: sharingCategories[k]?.label ?? k, description: sharingCategories[k]?.description ?? "" })),
      })),
    });
  });

  // ------------------------------------------------------------ notifications
  notifications.get("/", async (req, res) => {
    const [items, unread] = await Promise.all([
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50),
      Notification.countDocuments({ user: req.user._id, readAt: null }),
    ]);
    res.json({ items, unread });
  });

  notifications.post("/read", async (req, res) => {
    const { ids } = notificationReadSchema.parse(req.body);
    const filter = { user: req.user._id, readAt: null };
    if (ids) filter._id = mongoose.trusted({ $in: ids });
    await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    const unread = await Notification.countDocuments({ user: req.user._id, readAt: null });
    res.json({ unread });
  });

  return { opportunities, applications, notifications, consents };
}
