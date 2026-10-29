import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { startBroadcastDelivery } from "../lib/broadcast.js";
import { toCsv } from "../lib/csv.js";
import { evaluate } from "../lib/eligibility.js";
import { Application } from "../models/Application.js";
import { audit } from "../models/AuditLog.js";
import { Broadcast } from "../models/Broadcast.js";
import { Business } from "../models/Business.js";
import { Notification } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { ReminderLog } from "../models/ReminderLog.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { sectors, states, verificationStatuses } from "../options.js";
import { blankToUndefined, idParamSchema, intInRange, oneOf, optionalText, text } from "../schemas.js";

/**
 * Administrator tools: revoke and restore an owner's account, send a message to a group of owners, see which businesses
 * meet an opportunity, and archive or delete old opportunities. Every action is written to the activity log.
 */

const PAGE_SIZE = 20;
const BROADCAST_LINKS = ["", "/dashboard/", "/dashboard/opportunities/", "/dashboard/training/", "/dashboard/verification/", "/dashboard/documents/", "/dashboard/profile/"];
const labelRank = { Eligible: 0, "Nearly eligible": 1, "Not eligible": 2 };

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const accountSchema = z
  .object({ active: z.boolean({ message: "Choose active or revoked." }), reason: optionalText(200).default("") })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.active && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Say why the account is being revoked." });
  });

const audienceSchema = z
  .object({
    states: z.array(oneOf(states)).max(40).default([]),
    sectors: z.array(oneOf(sectors)).max(40).default([]),
    verificationStatuses: z.array(oneOf(verificationStatuses)).max(5).default([]),
  })
  .strict()
  .default({ states: [], sectors: [], verificationStatuses: [] });

const broadcastSchema = z
  .object({
    title: text(120),
    body: optionalText(300).default(""),
    link: oneOf(BROADCAST_LINKS).default(""),
    audience: audienceSchema,
    // Also email it to owners who have not turned notification emails off. It always goes to the app and to phones.
    sendEmail: z.boolean().default(true),
    // true only counts the people who would receive it.
    preview: z.boolean().default(false),
  })
  .strict();

const matchQuerySchema = z
  .object({
    label: z.preprocess(blankToUndefined, oneOf(["Eligible", "Nearly eligible", "Not eligible"]).optional()),
    page: z.preprocess(blankToUndefined, intInRange(1, 100000).optional()),
  })
  .strict();

/** The ids of active owner accounts whose business is in the audience. */
async function audienceOwnerIds(audience) {
  const match = {};
  if (audience.states.length) match.state = mongoose.trusted({ $in: audience.states });
  if (audience.sectors.length) match.sector = mongoose.trusted({ $in: audience.sectors });
  if (audience.verificationStatuses.length) match.verificationStatus = mongoose.trusted({ $in: audience.verificationStatuses });
  const rows = await Business.aggregate([
    { $match: match },
    { $lookup: { from: "users", localField: "owner", foreignField: "_id", as: "u" } },
    { $unwind: "$u" },
    { $match: { "u.active": { $ne: false }, "u.role": "msme_owner" } },
    { $project: { _id: 0, owner: 1 } },
  ]);
  return rows.map((r) => r.owner);
}

/** Every business scored against one opportunity, best match first. Revoked accounts are left out. */
async function matchesFor(opportunity) {
  const inactive = new Set((await User.find({ role: "msme_owner", active: false }).distinct("_id")).map(String));
  const applied = new Map((await Application.find({ opportunity: opportunity._id }).select("business status")).map((a) => [String(a.business), a.status]));
  const rows = [];
  for await (const b of Business.find({}).lean().cursor()) {
    if (inactive.has(String(b.owner))) continue;
    const fit = evaluate(opportunity.criteria, b);
    rows.push({
      businessId: String(b._id),
      businessName: b.businessName,
      nmrepId: b.nmrepId ?? null,
      state: b.state,
      sector: b.sector,
      verificationStatus: b.verificationStatus,
      fit: { label: fit.label, met: fit.met, total: fit.total, requiredMissing: fit.requiredMissing },
      applicationStatus: applied.get(String(b._id)) ?? null,
    });
  }
  rows.sort((a, b) => labelRank[a.fit.label] - labelRank[b.fit.label] || b.fit.met - a.fit.met || a.businessName.localeCompare(b.businessName));
  return rows;
}

export function adminToolsRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  // ------------------------------------------------------------ owner accounts
  // Revoking blocks sign-in and ends every session at once. Restoring lets the owner in again. Nothing is deleted.
  router.patch("/businesses/:id/account", async (req, res) => {
    const { active, reason } = accountSchema.parse(req.body);
    const business = await Business.findById(parseId(req.params.id));
    if (!business) throw new ApiError(404, "not_found", "Not found.");
    const user = await User.findById(business.owner);
    if (!user || user.role !== "msme_owner") throw new ApiError(404, "not_found", "Not found.");
    if ((user.active !== false) === active) {
      throw new ApiError(422, "validation", "The account is already in this state.", { active: "The account is already in this state." });
    }
    user.active = active;
    await user.save();
    if (!active) await Session.deleteMany({ user: user._id });
    await audit(req.user, active ? "owner.restore" : "owner.revoke", `${active ? "Restored" : "Revoked"} the account of "${business.businessName}"${active ? "" : `: ${reason}`}`.slice(0, 300), { type: "business", id: business._id });
    res.json({ owner: { id: String(user._id), active: user.active !== false } });
  });

  // ------------------------------------------------------------ broadcasts
  router.get("/broadcasts", async (_req, res) => {
    const items = await Broadcast.find({}).sort({ createdAt: -1 }).limit(50);
    const read = await Notification.aggregate([
      { $match: { broadcast: mongoose.trusted({ $in: items.map((b) => b._id) }), readAt: mongoose.trusted({ $ne: null }) } },
      { $group: { _id: "$broadcast", count: { $sum: 1 } } },
    ]);
    const readBy = new Map(read.map((r) => [String(r._id), r.count]));
    res.json({ items: items.map((b) => ({ ...b.toJSON(), read: readBy.get(String(b._id)) ?? 0 })) });
  });

  router.post("/broadcasts", async (req, res) => {
    const { title, body, link, audience, sendEmail, preview } = broadcastSchema.parse(req.body);
    const owners = await audienceOwnerIds(audience);
    if (preview) return res.json({ recipients: owners.length });
    if (owners.length === 0) throw new ApiError(422, "no_recipients", "No business owner matches this audience.", { audience: "No business owner matches this audience." });

    const broadcast = await Broadcast.create({ title, body, link, audience, sendEmail, recipients: owners.length, createdBy: req.user._id });
    // In chunks, so a large audience never becomes one huge write.
    for (let i = 0; i < owners.length; i += 500) {
      await Notification.insertMany(owners.slice(i, i + 500).map((user) => ({ user, type: "announcement", title, body, link, broadcast: broadcast._id })), { ordered: false });
    }
    // Phones and email follow in the background, so a large audience never holds the administrator up.
    startBroadcastDelivery({ owners, title, body, link, sendEmail, broadcastId: broadcast._id });
    await audit(req.user, "broadcast.send", `Sent "${title}" to ${owners.length} business owner${owners.length === 1 ? "" : "s"}${sendEmail ? ", by email too" : ""}`, { type: "broadcast", id: broadcast._id });
    res.status(201).json({ broadcast: { ...broadcast.toJSON(), read: 0 } });
  });

  // ------------------------------------------------------------ matching
  router.get("/opportunities/:id/matches", async (req, res) => {
    const { label, page = 1 } = matchQuerySchema.parse(req.query);
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    const all = await matchesFor(opportunity);
    const counts = { Eligible: 0, "Nearly eligible": 0, "Not eligible": 0 };
    for (const r of all) counts[r.fit.label] += 1;
    const rows = label ? all.filter((r) => r.fit.label === label) : all;
    res.json({
      opportunity: { id: String(opportunity._id), title: opportunity.title, status: opportunity.status },
      counts,
      total: rows.length,
      page,
      pageSize: PAGE_SIZE,
      items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    });
  });

  router.get("/opportunities/:id/matches.csv", async (req, res) => {
    const { label } = matchQuerySchema.parse(req.query);
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    const all = await matchesFor(opportunity);
    const rows = (label ? all.filter((r) => r.fit.label === label) : all).slice(0, 20000);
    const csv = toCsv(
      [
        { header: "Business", value: (r) => r.businessName },
        { header: "NMREP ID", value: (r) => r.nmrepId ?? "" },
        { header: "State", value: (r) => r.state },
        { header: "Sector", value: (r) => r.sector },
        { header: "Verification", value: (r) => r.verificationStatus },
        { header: "Fit", value: (r) => r.fit.label },
        { header: "Requirements met", value: (r) => r.fit.met },
        { header: "Requirements", value: (r) => r.fit.total },
        { header: "Application", value: (r) => r.applicationStatus ?? "" },
      ],
      rows,
    );
    await audit(req.user, "export.matches", `Exported ${rows.length} matching businesses for "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="nmrep-matches.csv"' });
    res.send(csv);
  });

  // ------------------------------------------------------------ archive and delete
  router.post("/opportunities/:id/archive", async (req, res) => {
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    if (opportunity.status === "Open" || opportunity.status === "Pending Approval") {
      throw new ApiError(409, "still_open", "Close it before archiving it.");
    }
    opportunity.archivedAt = new Date();
    await opportunity.save();
    await audit(req.user, "opportunity.archive", `Archived opportunity "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.json({ opportunity: opportunity.toJSON() });
  });

  router.post("/opportunities/:id/unarchive", async (req, res) => {
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    opportunity.archivedAt = null;
    await opportunity.save();
    await audit(req.user, "opportunity.unarchive", `Restored opportunity "${opportunity.title}" from the archive`, { type: "opportunity", id: opportunity._id });
    res.json({ opportunity: opportunity.toJSON() });
  });

  // Only an opportunity nobody has applied to can be deleted. Anything else is archived, so no application is orphaned.
  router.delete("/opportunities/:id", async (req, res) => {
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    if (opportunity.status === "Open") throw new ApiError(409, "still_open", "Close it before deleting it.");
    if (await Application.exists({ opportunity: opportunity._id })) {
      throw new ApiError(409, "has_applications", "People have applied to this opportunity, so it cannot be deleted. Archive it instead.");
    }
    await ReminderLog.deleteMany({ opportunity: opportunity._id });
    await opportunity.deleteOne();
    await audit(req.user, "opportunity.delete", `Deleted opportunity "${opportunity.title}"`, { type: "opportunity", id: opportunity._id });
    res.status(204).end();
  });

  return router;
}
