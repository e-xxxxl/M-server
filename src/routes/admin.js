import { Router } from "express";
import mongoose from "mongoose";
import { Agent } from "../models/Agent.js";
import { AuditLog, audit } from "../models/AuditLog.js";
import { Business } from "../models/Business.js";
import { notify } from "../models/Notification.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { newReferralCode, newTemporaryPassword } from "../lib/codes.js";
import { hashPassword } from "../lib/crypto.js";
import { issueNmrepId } from "../lib/ids.js";
import { duplicatesOf, latestChecks, reviewerView, verificationEnabled } from "../lib/verification.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import {
  adminCreateSchema,
  adminPatchSchema,
  agentCreateSchema,
  agentPatchSchema,
  businessListQuerySchema,
  idParamSchema,
  pageQuerySchema,
  statusChangeSchema,
} from "../schemas.js";

const PAGE_SIZE = 20;
const DAY = 24 * 60 * 60 * 1000;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A malformed id is simply "not found", never an error that reveals how ids are checked. */
function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const ownerSummary = (user) =>
  user
    ? {
        id: String(user._id),
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      }
    : null;

/** How many registrants each agent has brought in, as a Map of agent id to count. */
async function registrantCounts() {
  const rows = await Business.aggregate([
    { $match: { "referral.agent": { $ne: null } } },
    { $group: { _id: "$referral.agent", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

export function adminRoutes({ config }) {
  const router = Router();
  const superOnly = requireRole("super_admin");

  // Everything here needs a signed-in admin who has already replaced any temporary password.
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  // ---------------------------------------------------------------- overview
  router.get("/overview", async (_req, res) => {
    const now = Date.now();
    const [byStatus, total, last7, last30, referred, activeAgents, topReferrers, recent] = await Promise.all([
      Business.aggregate([{ $group: { _id: "$verificationStatus", count: { $sum: 1 } } }]),
      Business.countDocuments({}),
      Business.countDocuments({ createdAt: mongoose.trusted({ $gte: new Date(now - 7 * DAY) }) }),
      Business.countDocuments({ createdAt: mongoose.trusted({ $gte: new Date(now - 30 * DAY) }) }),
      Business.countDocuments({ "referral.agent": mongoose.trusted({ $ne: null }) }),
      Agent.countDocuments({ active: true }),
      Business.aggregate([
        { $match: { "referral.agent": { $ne: null } } },
        { $group: { _id: "$referral.agent", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        { $lookup: { from: "agents", localField: "_id", foreignField: "_id", as: "agent" } },
        { $unwind: "$agent" },
        { $project: { _id: 0, agentId: { $toString: "$_id" }, fullName: "$agent.fullName", code: "$agent.code", count: 1 } },
      ]),
      Business.find({}).sort({ createdAt: -1 }).limit(6).lean(),
    ]);

    const status = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
    res.json({
      totals: {
        businesses: total,
        last7Days: last7,
        last30Days: last30,
        referred,
        activeAgents,
        byStatus: {
          Unverified: status.Unverified ?? 0,
          "Pending Verification": status["Pending Verification"] ?? 0,
          Verified: status.Verified ?? 0,
          Rejected: status.Rejected ?? 0,
          Suspended: status.Suspended ?? 0,
        },
      },
      topReferrers,
      recent: recent.map((b) => ({
        id: String(b._id),
        businessName: b.businessName,
        ownerName: b.ownerName,
        state: b.state,
        sector: b.sector,
        verificationStatus: b.verificationStatus,
        createdAt: b.createdAt,
      })),
    });
  });

  // -------------------------------------------------------------- businesses
  router.get("/businesses", async (req, res) => {
    const query = businessListQuerySchema.parse(req.query);
    const page = query.page ?? 1;

    const match = {};
    if (query.status) match.verificationStatus = query.status;
    if (query.state) match.state = query.state;
    if (query.sector) match.sector = query.sector;
    if (query.agent) match["referral.agent"] = new mongoose.Types.ObjectId(query.agent);

    const pipeline = [
      { $match: match },
      { $lookup: { from: "users", localField: "owner", foreignField: "_id", as: "ownerUser" } },
      { $unwind: "$ownerUser" },
    ];
    if (query.q) {
      const re = escapeRegex(query.q);
      const like = (field) => ({ [field]: { $regex: re, $options: "i" } });
      pipeline.push({
        $match: { $or: [like("businessName"), like("ownerName"), like("ownerUser.email"), like("nmrepId"), like("referral.code")] },
      });
    }
    pipeline.push(
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * PAGE_SIZE },
            { $limit: PAGE_SIZE },
            {
              $project: {
                _id: 0,
                id: { $toString: "$_id" },
                businessName: 1,
                ownerName: 1,
                email: "$ownerUser.email",
                state: 1,
                sector: 1,
                verificationStatus: 1,
                nmrepId: 1,
                referralCode: "$referral.code",
                createdAt: 1,
              },
            },
          ],
          total: [{ $count: "n" }],
        },
      },
    );

    const [result] = await Business.aggregate(pipeline);
    res.json({ items: result.items, total: result.total[0]?.n ?? 0, page, pageSize: PAGE_SIZE });
  });

  router.get("/businesses/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const business = await Business.findById(id);
    if (!business) throw new ApiError(404, "not_found", "Not found.");
    const [owner, agent, checks] = await Promise.all([
      User.findById(business.owner),
      business.referral?.agent ? Agent.findById(business.referral.agent).lean() : null,
      latestChecks(business._id),
    ]);
    const verificationChecks = await Promise.all(checks.map(async (c) => reviewerView(c, await duplicatesOf(c))));
    res.json({
      business: business.toJSON(),
      owner: ownerSummary(owner),
      verificationChecks,
      automatedChecksAvailable: verificationEnabled(config),
      referral: business.referral?.code
        ? { code: business.referral.code, agentId: agent ? String(agent._id) : null, agentName: agent?.fullName ?? null }
        : null,
    });
  });

  // Manual review: the status shown on the owner's dashboard. Verified businesses receive their NMREP Business ID.
  router.post("/businesses/:id/status", async (req, res) => {
    const id = parseId(req.params.id);
    const { status, note } = statusChangeSchema.parse(req.body);
    const business = await Business.findById(id);
    if (!business) throw new ApiError(404, "not_found", "Not found.");
    if (business.verificationStatus === status) {
      throw new ApiError(422, "validation", "The business already has this status.", { status: "The business already has this status." });
    }

    business.verificationStatus = status;
    business.verificationHistory.push({ status, at: new Date(), note });
    if (status === "Verified" && !business.nmrepId) business.nmrepId = await issueNmrepId();
    await business.save();

    await audit(req.user, "business.status", `Set "${business.businessName}" to ${status}`, { type: "business", id });
    await notify(business.owner, {
      type: "verification",
      title: `Your verification status is now: ${status}`,
      body: note.slice(0, 300),
      link: "/dashboard/",
    });
    res.json({ business: business.toJSON() });
  });

  // ------------------------------------------------------- referral agents
  router.get("/agents", async (_req, res) => {
    const [agents, counts] = await Promise.all([Agent.find({}).sort({ createdAt: -1 }).lean(), registrantCounts()]);
    res.json({
      agents: agents.map((a) => ({
        id: String(a._id),
        fullName: a.fullName,
        phone: a.phone,
        email: a.email,
        notes: a.notes,
        code: a.code,
        active: a.active,
        createdAt: a.createdAt,
        registrants: counts.get(String(a._id)) ?? 0,
      })),
    });
  });

  router.post("/agents", async (req, res) => {
    const data = agentCreateSchema.parse(req.body);
    let agent;
    // A code collision is very unlikely, but is simply retried with a new code.
    for (let attempt = 0; attempt < 6 && !agent; attempt += 1) {
      try {
        agent = await Agent.create({ ...data, code: newReferralCode(), createdBy: req.user._id });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!agent) throw new ApiError(500, "server_error", "Could not generate a referral code. Please try again.");
    await audit(req.user, "agent.create", `Created referral code ${agent.code} for ${agent.fullName}`, { type: "agent", id: agent._id });
    res.status(201).json({ agent: { ...agent.toJSON(), registrants: 0 } });
  });

  router.get("/agents/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const agent = await Agent.findById(id);
    if (!agent) throw new ApiError(404, "not_found", "Not found.");
    const businesses = await Business.find({ "referral.agent": agent._id }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({
      agent: { ...agent.toJSON(), registrants: businesses.length },
      registrants: businesses.map((b) => ({
        id: String(b._id),
        businessName: b.businessName,
        ownerName: b.ownerName,
        state: b.state,
        verificationStatus: b.verificationStatus,
        createdAt: b.createdAt,
      })),
    });
  });

  router.patch("/agents/:id", async (req, res) => {
    const id = parseId(req.params.id);
    const patch = agentPatchSchema.parse(req.body);
    const agent = await Agent.findById(id);
    if (!agent) throw new ApiError(404, "not_found", "Not found.");

    const wasActive = agent.active;
    Object.assign(agent, patch);
    await agent.save();

    const what =
      patch.active !== undefined && patch.active !== wasActive
        ? `${patch.active ? "Reactivated" : "Deactivated"} referral code ${agent.code} (${agent.fullName})`
        : `Updated details of ${agent.fullName} (${agent.code})`;
    await audit(req.user, "agent.update", what, { type: "agent", id });
    const count = await Business.countDocuments({ "referral.agent": agent._id });
    res.json({ agent: { ...agent.toJSON(), registrants: count } });
  });

  // -------------------------------------------------- admin accounts (super admin)
  const staffFilter = () => ({ role: mongoose.trusted({ $in: ["admin", "super_admin"] }) });

  router.get("/admins", superOnly, async (_req, res) => {
    const staff = await User.find(staffFilter()).sort({ createdAt: 1 });
    res.json({ admins: staff.map((u) => u.toJSON()) });
  });

  router.post("/admins", superOnly, async (req, res) => {
    const data = adminCreateSchema.parse(req.body);
    if (await User.exists({ email: data.email })) {
      throw new ApiError(409, "email_taken", "An account with this email address already exists.", {
        email: "An account with this email address already exists.",
      });
    }
    // The temporary password is shown to the super admin once and never stored in readable form.
    const temporaryPassword = newTemporaryPassword();
    const admin = await User.create({
      ...data,
      passwordHash: await hashPassword(temporaryPassword, config.bcryptRounds),
      role: "admin",
      mustChangePassword: true,
      createdBy: req.user._id,
    });
    await audit(req.user, "admin.create", `Created admin account for ${admin.fullName}`, { type: "user", id: admin._id });
    res.status(201).json({ admin: admin.toJSON(), temporaryPassword });
  });

  // Only plain admins can be changed here. Super admins are managed outside the portal.
  async function plainAdmin(idValue) {
    const target = await User.findById(parseId(idValue));
    if (!target || target.role !== "admin") throw new ApiError(404, "not_found", "Not found.");
    return target;
  }

  router.patch("/admins/:id", superOnly, async (req, res) => {
    const { active } = adminPatchSchema.parse(req.body);
    const target = await plainAdmin(req.params.id);
    target.active = active;
    await target.save();
    if (!active) await Session.deleteMany({ user: target._id }); // signed out everywhere immediately
    await audit(req.user, "admin.update", `${active ? "Reactivated" : "Deactivated"} admin account for ${target.fullName}`, { type: "user", id: target._id });
    res.json({ admin: target.toJSON() });
  });

  router.post("/admins/:id/reset-password", superOnly, async (req, res) => {
    const target = await plainAdmin(req.params.id);
    const temporaryPassword = newTemporaryPassword();
    target.passwordHash = await hashPassword(temporaryPassword, config.bcryptRounds);
    target.mustChangePassword = true;
    target.failedLogins = 0;
    target.lockUntil = null;
    await target.save();
    await Session.deleteMany({ user: target._id });
    await audit(req.user, "admin.reset-password", `Reset the password of ${target.fullName}`, { type: "user", id: target._id });
    res.json({ admin: target.toJSON(), temporaryPassword });
  });

  // ------------------------------------------------------------ activity log
  router.get("/audit", superOnly, async (req, res) => {
    const { page = 1 } = pageQuerySchema.parse(req.query);
    const [entries, total] = await Promise.all([
      AuditLog.find({})
        .sort({ at: -1 })
        .skip((page - 1) * 30)
        .limit(30)
        .lean(),
      AuditLog.countDocuments({}),
    ]);
    res.json({
      items: entries.map((e) => ({
        id: String(e._id),
        actorName: e.actorName,
        action: e.action,
        summary: e.summary,
        targetType: e.targetType,
        targetId: e.targetId,
        at: e.at,
      })),
      total,
      page,
      pageSize: 30,
    });
  });

  return router;
}
