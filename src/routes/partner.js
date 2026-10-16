import { Router } from "express";
import mongoose from "mongoose";
import { evaluate } from "../lib/eligibility.js";
import { applicationStatuses, beneficiaryStatuses, reviewTransitions, reviewableStatuses } from "../lib/opportunity-constants.js";
import { applyReview } from "../lib/review.js";
import { applicantView } from "../lib/sharing.js";
import { Application } from "../models/Application.js";
import { audit } from "../models/AuditLog.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { User } from "../models/User.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { idParamSchema } from "../schemas.js";
import {
  applicationListQuerySchema,
  applicationStatusSchema,
  opportunityListQuerySchema,
  partnerOpportunityCreateSchema,
  partnerOpportunityPatchSchema,
} from "../schemas-opportunities.js";

const PAGE_SIZE = 20;

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const publicOpportunity = (opportunity) => {
  const json = opportunity.toJSON();
  delete json.createdBy;
  return json;
};

/**
 * The partner portal. Every query here is limited to the signed in partner's own organisation, so one
 * organisation can never see another's opportunities or applicants (framework section 18).
 */
export function partnerRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("partner"));

  // The portal reads this first, even while a temporary password is still to be replaced.
  router.get("/me", async (req, res) => {
    const org = await Organisation.findById(req.user.organisation);
    res.json({ user: req.user, organisation: org ? org.toJSON() : null });
  });

  router.use(requirePasswordChanged);
  router.use(async (req, _res, next) => {
    req.org = await Organisation.findById(req.user.organisation);
    if (!req.org) throw new ApiError(404, "not_found", "Not found.");
    next();
  });

  const ownOpportunity = async (req, idValue) => {
    const opportunity = await Opportunity.findOne({ _id: parseId(idValue), organisation: req.org._id });
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    return opportunity;
  };

  const ownOpportunityIds = (req) => Opportunity.find({ organisation: req.org._id }).distinct("_id");

  /** An application to one of this organisation's opportunities that is not a draft, or a plain 404. */
  const ownApplication = async (req, idValue) => {
    const application = await Application.findById(parseId(idValue));
    const opportunity = application ? await Opportunity.findOne({ _id: application.opportunity, organisation: req.org._id }) : null;
    if (!application || !opportunity || application.status === "Draft") throw new ApiError(404, "not_found", "Not found.");
    return { application, opportunity };
  };

  /** The applicant as this organisation may see them, from the owner's current agreement. */
  async function applicantFor(application) {
    const consent = await ConsentRecord.findOne({ application: application._id, revokedAt: null }).sort({ grantedAt: -1 });
    if (!consent || !application.snapshot) return { applicant: null, shared: [] };
    const owner = consent.categories.includes("contact") ? await User.findById(application.owner) : null;
    return { applicant: applicantView(application.snapshot, owner, consent.categories), shared: consent.categories };
  }

  // ----------------------------------------------------------------- overview
  router.get("/overview", async (req, res) => {
    const ids = await ownOpportunityIds(req);
    const [opps, apps] = await Promise.all([
      Opportunity.aggregate([{ $match: { organisation: req.org._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      Application.aggregate([
        { $match: { opportunity: { $in: ids }, status: { $in: reviewableStatuses } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
    const appMap = toMap(apps);
    res.json({
      organisation: req.org.toJSON(),
      opportunities: toMap(opps),
      applications: Object.fromEntries(reviewableStatuses.map((s) => [s, appMap[s] ?? 0])),
      beneficiaries: beneficiaryStatuses.reduce((n, s) => n + (appMap[s] ?? 0), 0),
    });
  });

  // ------------------------------------------------------------ opportunities
  router.get("/opportunities", async (req, res) => {
    const { status } = opportunityListQuerySchema.parse(req.query);
    const items = await Opportunity.find(status ? { organisation: req.org._id, status } : { organisation: req.org._id }).sort({ createdAt: -1 }).limit(200);
    const counts = await Application.aggregate([
      { $match: { opportunity: { $in: items.map((o) => o._id) }, status: { $ne: "Draft" } } },
      { $group: { _id: "$opportunity", count: { $sum: 1 } } },
    ]);
    const perOpp = new Map(counts.map((r) => [String(r._id), r.count]));
    res.json({ items: items.map((o) => ({ ...publicOpportunity(o), applications: perOpp.get(String(o._id)) ?? 0 })) });
  });

  // A new opportunity is always a draft owned by this organisation. NMREP approves it before owners can see it.
  router.post("/opportunities", async (req, res) => {
    const data = partnerOpportunityCreateSchema.parse(req.body);
    const opportunity = await Opportunity.create({ ...data, provider: req.org.name, organisation: req.org._id, createdBy: req.user._id });
    await audit(req.user, "opportunity.create", `${req.org.name} created opportunity "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.status(201).json({ opportunity: publicOpportunity(opportunity) });
  });

  router.get("/opportunities/:id", async (req, res) => {
    const opportunity = await ownOpportunity(req, req.params.id);
    const rows = await Application.aggregate([{ $match: { opportunity: opportunity._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
    const counts = Object.fromEntries(applicationStatuses.map((s) => [s, 0]));
    for (const r of rows) counts[r._id] = r.count;
    res.json({ opportunity: publicOpportunity(opportunity), applications: counts });
  });

  // Only a draft can be edited. After it is submitted, changes go through NMREP.
  router.patch("/opportunities/:id", async (req, res) => {
    const patch = partnerOpportunityPatchSchema.parse(req.body);
    const opportunity = await ownOpportunity(req, req.params.id);
    if (opportunity.status !== "Draft") {
      throw new ApiError(409, "locked", "Only a draft can be edited. Ask NMREP to change an opportunity that has been submitted.");
    }
    Object.assign(opportunity, patch);
    await opportunity.save();
    res.json({ opportunity: publicOpportunity(opportunity) });
  });

  router.post("/opportunities/:id/submit", async (req, res) => {
    const opportunity = await ownOpportunity(req, req.params.id);
    if (opportunity.status !== "Draft") throw new ApiError(409, "not_draft", "Only a draft can be submitted for approval.");
    opportunity.status = "Pending Approval";
    opportunity.reviewNote = "";
    await opportunity.save();
    await audit(req.user, "opportunity.submit", `${req.org.name} submitted "${opportunity.title}" for approval`, { type: "opportunity", id: opportunity._id });
    res.json({ opportunity: publicOpportunity(opportunity) });
  });

  router.post("/opportunities/:id/close", async (req, res) => {
    const opportunity = await ownOpportunity(req, req.params.id);
    if (opportunity.status !== "Open") throw new ApiError(409, "not_open", "Only an open opportunity can be closed.");
    opportunity.status = "Closed";
    await opportunity.save();
    await audit(req.user, "opportunity.close", `${req.org.name} closed "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.json({ opportunity: publicOpportunity(opportunity) });
  });

  // ------------------------------------------------------------- applications
  router.get("/applications", async (req, res) => {
    const { page = 1, status, opportunity } = applicationListQuerySchema.parse(req.query);
    const ids = await ownOpportunityIds(req);
    const filter = { opportunity: mongoose.trusted({ $in: ids }), status: status ?? mongoose.trusted({ $in: reviewableStatuses }) };
    if (opportunity) {
      if (!ids.map(String).includes(opportunity)) throw new ApiError(404, "not_found", "Not found.");
      filter.opportunity = opportunity;
    }
    const [rows, total] = await Promise.all([
      Application.find(filter).sort({ submittedAt: -1, updatedAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
      Application.countDocuments(filter),
    ]);
    const [opps, consents] = await Promise.all([
      Opportunity.find({ _id: mongoose.trusted({ $in: rows.map((r) => r.opportunity) }) }).select("title"),
      ConsentRecord.find({ application: mongoose.trusted({ $in: rows.map((r) => r._id) }), revokedAt: null }).select("application"),
    ]);
    const title = new Map(opps.map((o) => [String(o._id), o.title]));
    const sharing = new Set(consents.map((c) => String(c.application)));
    res.json({
      items: rows.map((a) => {
        const visible = sharing.has(String(a._id)) && a.snapshot;
        return {
          id: String(a._id),
          opportunityId: String(a.opportunity),
          opportunityTitle: title.get(String(a.opportunity)) ?? "",
          // Names appear only while the applicant is sharing. After a withdrawal they are gone.
          businessName: visible ? a.snapshot.businessName : null,
          state: visible ? a.snapshot.state : null,
          status: a.status,
          submittedAt: a.submittedAt,
        };
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    });
  });

  router.get("/applications/:id", async (req, res) => {
    const { application, opportunity } = await ownApplication(req, req.params.id);
    const { applicant, shared } = await applicantFor(application);
    res.json({
      application: {
        id: String(application._id),
        status: application.status,
        message: applicant ? application.message : "",
        submittedAt: application.submittedAt,
        history: application.history,
      },
      opportunity: { id: String(opportunity._id), title: opportunity.title },
      applicant,
      shared,
      // How the business compared with the requirements, from the profile summary it agreed to share.
      fit: applicant && application.snapshot ? evaluate(opportunity.criteria, application.snapshot) : null,
      allowed: reviewTransitions[application.status] ?? [],
    });
  });

  router.post("/applications/:id/status", async (req, res) => {
    const { status, note } = applicationStatusSchema.parse(req.body);
    const { application } = await ownApplication(req, req.params.id);
    await applyReview(application, status, note, req.user);
    res.json({ application: { id: String(application._id), status: application.status, history: application.history } });
  });

  // ------------------------------------------------------------- beneficiaries
  router.get("/beneficiaries", async (req, res) => {
    const ids = await ownOpportunityIds(req);
    const rows = await Application.find({ opportunity: mongoose.trusted({ $in: ids }), status: mongoose.trusted({ $in: beneficiaryStatuses }) })
      .sort({ updatedAt: -1 })
      .limit(500);
    const opps = new Map((await Opportunity.find({ _id: mongoose.trusted({ $in: ids }) }).select("title")).map((o) => [String(o._id), o.title]));
    const items = [];
    for (const application of rows) {
      const { applicant, shared } = await applicantFor(application);
      items.push({
        applicationId: String(application._id),
        opportunityId: String(application.opportunity),
        opportunityTitle: opps.get(String(application.opportunity)) ?? "",
        status: application.status,
        decidedAt: application.history.at(-1)?.at ?? application.updatedAt,
        applicant,
        shared,
      });
    }
    res.json({ items });
  });

  // ------------------------------------------------------------------ reports
  router.get("/reports", async (req, res) => {
    const ids = await ownOpportunityIds(req);
    const match = { opportunity: { $in: ids }, status: { $in: reviewableStatuses.filter((s) => s !== "Withdrawn") } };
    const group = (field) => [{ $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }];
    const named = (rows) => rows.map((r) => ({ name: r._id || "Not set", count: r.count }));
    const [byStatus, byState, bySector, perOpportunity] = await Promise.all([
      Application.aggregate([{ $match: { opportunity: { $in: ids }, status: { $in: reviewableStatuses } } }, ...group("$status")]),
      Application.aggregate([{ $match: match }, ...group("$snapshot.state")]),
      Application.aggregate([{ $match: match }, ...group("$snapshot.sector")]),
      Application.aggregate([
        { $match: { opportunity: { $in: ids }, status: { $in: reviewableStatuses } } },
        {
          $group: {
            _id: "$opportunity",
            total: { $sum: 1 },
            approved: { $sum: { $cond: [{ $in: ["$status", beneficiaryStatuses] }, 1, 0] } },
            declined: { $sum: { $cond: [{ $eq: ["$status", "Declined"] }, 1, 0] } },
          },
        },
        { $sort: { total: -1 } },
        { $lookup: { from: "opportunities", localField: "_id", foreignField: "_id", as: "o" } },
        { $unwind: "$o" },
        { $project: { _id: 0, title: "$o.title", total: 1, approved: 1, declined: 1, limit: "$o.beneficiaryLimit" } },
      ]),
    ]);
    res.json({
      applicationsByStatus: named(byStatus),
      applicantsByState: named(byState),
      applicantsBySector: named(bySector),
      applicationsPerOpportunity: perOpportunity,
    });
  });

  return router;
}
