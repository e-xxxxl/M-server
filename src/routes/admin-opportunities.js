import { Router } from "express";
import mongoose from "mongoose";
import { openOpportunity } from "../lib/announce.js";
import { toCsv } from "../lib/csv.js";
import { evaluate } from "../lib/eligibility.js";
import { applicationStatuses, reviewTransitions, reviewableStatuses } from "../lib/opportunity-constants.js";
import { sendDocument, sharedView, visibleDocuments } from "../lib/documents.js";
import { applyReview } from "../lib/review.js";
import { Agent } from "../models/Agent.js";
import { Application } from "../models/Application.js";
import { audit } from "../models/AuditLog.js";
import { Business } from "../models/Business.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { User } from "../models/User.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { idParamSchema } from "../schemas.js";
import { normaliseQuestions } from "../lib/opportunity-form.js";
import { businessBreakdowns, trainingStats } from "../lib/report-breakdowns.js";
import { Payment } from "../models/Payment.js";
import { trainingStaffRoutes } from "./training.js";
import {
  applicationListQuerySchema,
  applicationStatusSchema,
  opportunityCreateSchema,
  opportunityListQuerySchema,
  opportunityPatchSchema,
  returnSchema,
} from "../schemas-opportunities.js";

const PAGE_SIZE = 20;

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const countsByStatus = (rows) => {
  const counts = Object.fromEntries(applicationStatuses.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = r.count;
  return counts;
};

/** Organisation names for a list of ids, as a Map of id to { name, type }. */
async function organisationsById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const rows = await Organisation.find({ _id: mongoose.trusted({ $in: unique }) }).select("name type").lean();
  return new Map(rows.map((o) => [String(o._id), { id: String(o._id), name: o.name, type: o.type }]));
}

export function adminOpportunityRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  // Running any training: plan, attendance, assessment and certificates.
  router.use("/training", trainingStaffRoutes({ scope: () => ({}), viewer: "admin" }));

  // ------------------------------------------------------------ opportunities
  router.get("/opportunities", async (req, res) => {
    const { status, archived } = opportunityListQuerySchema.parse(req.query);
    const [items, perStatus] = await Promise.all([
      Opportunity.find({ ...(status ? { status } : {}), archivedAt: archived ? mongoose.trusted({ $ne: null }) : null }).sort({ createdAt: -1 }).limit(200),
      Application.aggregate([
        { $match: { status: { $ne: "Draft" } } },
        { $group: { _id: { opportunity: "$opportunity", status: "$status" }, count: { $sum: 1 } } },
      ]),
    ]);
    const totals = new Map();
    for (const r of perStatus) {
      const key = String(r._id.opportunity);
      totals.set(key, (totals.get(key) ?? 0) + r.count);
    }
    const orgs = await organisationsById(items.map((o) => o.organisation));
    const pending = await Opportunity.countDocuments({ status: "Pending Approval" });
    res.json({
      items: items.map((o) => ({
        ...o.toJSON(),
        applications: totals.get(String(o._id)) ?? 0,
        organisationName: o.organisation ? (orgs.get(String(o.organisation))?.name ?? "Removed") : null,
      })),
      pendingApproval: pending,
    });
  });

  router.post("/opportunities", async (req, res) => {
    const data = opportunityCreateSchema.parse(req.body);
    const opportunity = await Opportunity.create({ ...data, questions: normaliseQuestions(data.questions), createdBy: req.user._id });
    await audit(req.user, "opportunity.create", `Created opportunity "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.status(201).json({ opportunity: opportunity.toJSON() });
  });

  router.get("/opportunities/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const opportunity = await Opportunity.findById(id);
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    const [rows, orgs] = await Promise.all([
      Application.aggregate([{ $match: { opportunity: opportunity._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      organisationsById([opportunity.organisation]),
    ]);
    res.json({
      opportunity: opportunity.toJSON(),
      organisation: opportunity.organisation ? (orgs.get(String(opportunity.organisation)) ?? null) : null,
      applications: countsByStatus(rows.map((r) => ({ status: r._id, count: r.count }))),
    });
  });

  router.patch("/opportunities/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const patch = opportunityPatchSchema.parse(req.body);
    const opportunity = await Opportunity.findById(id);
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");

    const { status, ...fields } = patch;
    if (fields.questions) fields.questions = normaliseQuestions(fields.questions, opportunity.questions);
    Object.assign(opportunity, fields);
    if (status === "Open" && opportunity.status !== "Open") {
      await openOpportunity(opportunity); // saves, and tells qualifying owners the first time
    } else {
      if (status) opportunity.status = status;
      await opportunity.save();
    }
    await audit(req.user, "opportunity.update", `Opportunity "${opportunity.title}" ${status ? `set to ${status}` : "edited"}`, {
      type: "opportunity",
      id,
    });
    res.json({ opportunity: opportunity.toJSON() });
  });

  // A partner's opportunity waits here until a platform admin approves it.
  router.post("/opportunities/:id/approve", async (req, res) => {
    const id = parseId(req.params.id);
    const opportunity = await Opportunity.findById(id);
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    if (opportunity.status !== "Pending Approval") {
      throw new ApiError(409, "not_pending", "This opportunity is not waiting for approval.");
    }
    await openOpportunity(opportunity);
    await audit(req.user, "opportunity.approve", `Approved opportunity "${opportunity.title}"`, { type: "opportunity", id });
    res.json({ opportunity: opportunity.toJSON() });
  });

  router.post("/opportunities/:id/return", async (req, res) => {
    const id = parseId(req.params.id);
    const { note } = returnSchema.parse(req.body);
    const opportunity = await Opportunity.findById(id);
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    if (opportunity.status !== "Pending Approval") {
      throw new ApiError(409, "not_pending", "This opportunity is not waiting for approval.");
    }
    opportunity.status = "Draft";
    opportunity.reviewNote = note;
    await opportunity.save();
    await audit(req.user, "opportunity.return", `Sent opportunity "${opportunity.title}" back to its partner`, { type: "opportunity", id });
    res.json({ opportunity: opportunity.toJSON() });
  });

  // ------------------------------------------------------------- applications
  router.get("/applications", async (req, res) => {
    const { page = 1, status, opportunity, organisation } = applicationListQuerySchema.parse(req.query);
    const filter = { status: status ?? mongoose.trusted({ $in: reviewableStatuses }) };
    if (opportunity) filter.opportunity = opportunity;
    if (organisation) {
      const ids = await Opportunity.find({ organisation }).distinct("_id");
      filter.opportunity = opportunity ? (ids.map(String).includes(opportunity) ? opportunity : null) : mongoose.trusted({ $in: ids });
    }
    const [rows, total] = await Promise.all([
      Application.find(filter)
        .sort({ submittedAt: -1, updatedAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      Application.countDocuments(filter),
    ]);
    const [opps, businesses] = await Promise.all([
      Opportunity.find({ _id: mongoose.trusted({ $in: rows.map((r) => r.opportunity) }) }).select("title organisation"),
      Business.find({ _id: mongoose.trusted({ $in: rows.map((r) => r.business) }) }).select("businessName state"),
    ]);
    const orgs = await organisationsById(opps.map((o) => o.organisation));
    const opp = new Map(opps.map((o) => [String(o._id), o]));
    const biz = new Map(businesses.map((b) => [String(b._id), b]));
    res.json({
      items: rows.map((a) => {
        const o = opp.get(String(a.opportunity));
        return {
          id: String(a._id),
          opportunityId: String(a.opportunity),
          opportunityTitle: o?.title ?? "Removed",
          organisationName: o?.organisation ? (orgs.get(String(o.organisation))?.name ?? "Removed") : null,
          businessId: String(a.business),
          businessName: biz.get(String(a.business))?.businessName ?? "Removed",
          state: biz.get(String(a.business))?.state ?? "",
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
    const application = await Application.findById(parseId(req.params.id));
    if (!application || application.status === "Draft") throw new ApiError(404, "not_found", "Not found.");
    const [opportunity, business, owner, consents] = await Promise.all([
      Opportunity.findById(application.opportunity),
      Business.findById(application.business).select("businessName"),
      User.findById(application.owner),
      ConsentRecord.find({ application: application._id }).sort({ grantedAt: -1 }),
    ]);
    const orgs = await organisationsById([opportunity?.organisation]);
    res.json({
      application: application.toJSON(),
      opportunity: opportunity
        ? {
            id: String(opportunity._id),
            title: opportunity.title,
            provider: opportunity.provider,
            type: opportunity.type,
            organisationName: opportunity.organisation ? (orgs.get(String(opportunity.organisation))?.name ?? null) : null,
          }
        : null,
      business: business ? { id: String(business._id), businessName: business.businessName } : null,
      owner: owner ? { fullName: owner.fullName, email: owner.email, phone: owner.phone } : null,
      // How the business compared with the requirements when it submitted.
      fit: opportunity && application.snapshot ? evaluate(opportunity.criteria, application.snapshot) : null,
      consents: consents.map((c) => c.toJSON()),
      documents: (await visibleDocuments(application)).map(sharedView),
      allowed: reviewTransitions[application.status] ?? [],
    });
  });

  // A document attached to this application, while the owner's sharing agreement is active. Every download is logged.
  router.get("/applications/:id/documents/:docId", async (req, res) => {
    const application = await Application.findById(parseId(req.params.id));
    if (!application || application.status === "Draft") throw new ApiError(404, "not_found", "Not found.");
    const docs = await visibleDocuments(application);
    const doc = docs.find((d) => String(d._id) === parseId(req.params.docId));
    if (!doc) throw new ApiError(404, "not_found", "Not found.");
    await audit(req.user, "document.download", `Downloaded "${doc.title}" (${doc.kind}) from an application`, { type: "application", id: application._id });
    await sendDocument(res, doc);
  });


  router.post("/applications/:id/status", async (req, res) => {
    const { status, note } = applicationStatusSchema.parse(req.body);
    const application = await Application.findById(parseId(req.params.id));
    if (!application || application.status === "Draft") throw new ApiError(404, "not_found", "Not found.");
    await applyReview(application, status, note, req.user);
    res.json({ application: application.toJSON() });
  });

  // ------------------------------------------------------------------ reports
  router.get("/reports", async (_req, res) => {
    const monthsBack = 12;
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCMonth(since.getUTCMonth() - (monthsBack - 1));

    const group = (field) => [{ $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }];
    const [total, byState, bySector, byStatus, byMonth, referrers, appStatus, perOpportunity] = await Promise.all([
      Business.countDocuments({}),
      Business.aggregate(group("$state")),
      Business.aggregate(group("$sector")),
      Business.aggregate(group("$verificationStatus")),
      Business.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Business.aggregate([
        { $match: { "referral.agent": { $ne: null } } },
        { $group: { _id: "$referral.agent", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $lookup: { from: "agents", localField: "_id", foreignField: "_id", as: "agent" } },
        { $unwind: "$agent" },
        { $project: { _id: 0, name: "$agent.fullName", code: "$agent.code", count: 1 } },
      ]),
      Application.aggregate([{ $match: { status: { $ne: "Draft" } } }, ...group("$status")]),
      Application.aggregate([
        { $match: { status: { $ne: "Draft" } } },
        {
          $group: {
            _id: "$opportunity",
            total: { $sum: 1 },
            approved: { $sum: { $cond: [{ $in: ["$status", ["Approved", "Completed"]] }, 1, 0] } },
            declined: { $sum: { $cond: [{ $eq: ["$status", "Declined"] }, 1, 0] } },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 20 },
        { $lookup: { from: "opportunities", localField: "_id", foreignField: "_id", as: "o" } },
        { $unwind: "$o" },
        { $project: { _id: 0, title: "$o.title", total: 1, approved: 1, declined: 1 } },
      ]),
    ]);
    const named = (rows) => rows.map((r) => ({ name: r._id || "Not set", count: r.count }));
    res.json({
      totalBusinesses: total,
      byState: named(byState),
      bySector: named(bySector),
      byStatus: named(byStatus),
      byMonth: byMonth.map((r) => ({ month: r._id, count: r.count })),
      topReferrers: referrers,
      applicationsByStatus: named(appStatus),
      applicationsPerOpportunity: perOpportunity,
      ...(await businessBreakdowns()),
      training: await trainingStats(),
      registrationFees: await (async () => {
        const [row] = await Payment.aggregate([{ $match: { status: "success" } }, { $group: { _id: null, payments: { $sum: 1 }, kobo: { $sum: "$amountKobo" } } }]);
        return { payments: row?.payments ?? 0, totalNaira: (row?.kobo ?? 0) / 100 };
      })(),
    });
  });

  // ------------------------------------------------------------------ exports
  const sendCsv = (res, filename, csv) => {
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` });
    res.send(csv);
  };

  router.get("/export/businesses", async (req, res) => {
    const businesses = await Business.find({}).sort({ createdAt: -1 }).limit(20000).lean();
    const owners = new Map(
      (await User.find({ _id: mongoose.trusted({ $in: businesses.map((b) => b.owner) }) }).select("fullName email phone").lean()).map((u) => [String(u._id), u]),
    );
    const agentIds = [...new Set(businesses.map((b) => b.referral?.agent).filter(Boolean).map(String))];
    const agents = new Map((await Agent.find({ _id: mongoose.trusted({ $in: agentIds }) }).select("fullName").lean()).map((a) => [String(a._id), a.fullName]));
    const csv = toCsv(
      [
        { header: "NMREP ID", value: (b) => b.nmrepId ?? "" },
        { header: "Business name", value: (b) => b.businessName },
        { header: "Verification status", value: (b) => b.verificationStatus },
        { header: "Business type", value: (b) => b.businessType },
        { header: "Sector", value: (b) => b.sector },
        { header: "State", value: (b) => b.state },
        { header: "LGA", value: (b) => b.lga },
        { header: "Employees", value: (b) => b.employees },
        { header: "Year established", value: (b) => b.yearEstablished },
        { header: "Owner", value: (b) => owners.get(String(b.owner))?.fullName ?? "" },
        { header: "Owner email", value: (b) => owners.get(String(b.owner))?.email ?? "" },
        { header: "Owner phone", value: (b) => owners.get(String(b.owner))?.phone ?? "" },
        { header: "Referral code", value: (b) => b.referral?.code ?? "" },
        { header: "Referred by", value: (b) => agents.get(String(b.referral?.agent)) ?? "" },
        { header: "Registered", value: (b) => b.createdAt },
      ],
      businesses,
    );
    await audit(req.user, "export.businesses", `Exported ${businesses.length} businesses to CSV`, { type: "export" });
    sendCsv(res, "nmrep-businesses.csv", csv);
  });

  router.get("/export/applications", async (req, res) => {
    const rows = await Application.find({ status: mongoose.trusted({ $in: reviewableStatuses }) }).sort({ submittedAt: -1 }).limit(20000).lean();
    const [opps, businesses] = await Promise.all([
      Opportunity.find({ _id: mongoose.trusted({ $in: rows.map((r) => r.opportunity) }) }).select("title provider organisation").lean(),
      Business.find({ _id: mongoose.trusted({ $in: rows.map((r) => r.business) }) }).select("businessName state nmrepId").lean(),
    ]);
    const orgs = await organisationsById(opps.map((o) => o.organisation));
    const o = new Map(opps.map((x) => [String(x._id), x]));
    const b = new Map(businesses.map((x) => [String(x._id), x]));
    const csv = toCsv(
      [
        { header: "Opportunity", value: (a) => o.get(String(a.opportunity))?.title ?? "" },
        { header: "Provider", value: (a) => o.get(String(a.opportunity))?.provider ?? "" },
        { header: "Organisation", value: (a) => orgs.get(String(o.get(String(a.opportunity))?.organisation))?.name ?? "NMREP" },
        { header: "Business", value: (a) => b.get(String(a.business))?.businessName ?? "" },
        { header: "NMREP ID", value: (a) => b.get(String(a.business))?.nmrepId ?? "" },
        { header: "State", value: (a) => b.get(String(a.business))?.state ?? "" },
        { header: "Status", value: (a) => a.status },
        { header: "Submitted", value: (a) => a.submittedAt },
      ],
      rows,
    );
    await audit(req.user, "export.applications", `Exported ${rows.length} applications to CSV`, { type: "export" });
    sendCsv(res, "nmrep-applications.csv", csv);
  });

  return router;
}
