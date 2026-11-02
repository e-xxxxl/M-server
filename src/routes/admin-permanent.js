import { Router } from "express";
import mongoose from "mongoose";
import { sendAccountDeleted } from "../lib/account-emails.js";
import { deleteOwnerData } from "../lib/account-deletion.js";
import { verifyPassword } from "../lib/crypto.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { Agent } from "../models/Agent.js";
import { Application } from "../models/Application.js";
import { audit } from "../models/AuditLog.js";
import { Broadcast } from "../models/Broadcast.js";
import { Business } from "../models/Business.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { EmailToken } from "../models/EmailToken.js";
import { Notification } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { ReminderLog } from "../models/ReminderLog.js";
import { Session } from "../models/Session.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { User } from "../models/User.js";
import { idParamSchema, permanentDeleteSchema } from "../schemas.js";

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

/** Ends the consent records of applications that are about to be deleted. The records stay as proof of what was shared. */
const endConsents = (applicationIds, reason) =>
  applicationIds.length === 0
    ? Promise.resolve()
    : ConsentRecord.updateMany({ application: mongoose.trusted({ $in: applicationIds }), revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });

/**
 * Permanent deletion, for the super admin only. Everything here removes records from the database for good, so every call
 * needs three things: the super admin's own password, a reason, and the exact name of the thing being deleted typed
 * out. Each is written to the activity log (what was deleted, why and by whom, never any profile data). The activity log
 * itself, ended consent records and payment records are never deleted: they are the accountability trail.
 */
export function adminPermanentRoutes({ config, limiters }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("super_admin"), requirePasswordChanged);

  /** Checks the three confirmations. `expected` is what must be typed to confirm. */
  async function confirmed(req, expected) {
    const { password, reason, confirm } = permanentDeleteSchema.parse(req.body);
    const me = await User.findById(req.user._id).select("+passwordHash");
    if (!me || !(await verifyPassword(password, me.passwordHash))) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", { password: "Your password is incorrect." });
    }
    if (confirm !== expected) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", { confirm: "Type the name exactly as shown to confirm." });
    }
    return { reason };
  }
  const done = async (req, action, summary, reason, target, deleted) => {
    await audit(req.user, action, `${summary} Reason: ${reason}`.slice(0, 300), target);
    return { deleted };
  };

  // An owner account and everything of theirs: the business, applications, documents and their files, products and pictures.
  router.delete("/businesses/:id", limiters.login, async (req, res) => {
    const business = await Business.findById(parseId(req.params.id));
    if (!business) throw new ApiError(404, "not_found", "Not found.");
    const { reason } = await confirmed(req, business.businessName);
    const owner = await User.findById(business.owner);
    let counts = {};
    if (owner) counts = await deleteOwnerData(owner, { reason: "Account deleted by NMREP" });
    else await Business.deleteOne({ _id: business._id });
    if (owner) sendAccountDeleted(owner);
    res.json(await done(req, "permanent.business", `Permanently deleted the business "${business.businessName}" and its account.`, reason, { type: "business", id: business._id }, { kind: "business", name: business.businessName, ...counts }));
  });

  // An opportunity even when people have applied: the applications and training records go with it.
  router.delete("/opportunities/:id", limiters.login, async (req, res) => {
    const opportunity = await Opportunity.findById(parseId(req.params.id));
    if (!opportunity) throw new ApiError(404, "not_found", "Not found.");
    const { reason } = await confirmed(req, opportunity.title);
    const applicationIds = (await Application.find({ opportunity: opportunity._id }).select("_id")).map((a) => a._id);
    await endConsents(applicationIds, "Opportunity deleted by NMREP");
    const trainingRecords = (await TrainingRecord.deleteMany({ opportunity: opportunity._id })).deletedCount;
    const applications = (await Application.deleteMany({ opportunity: opportunity._id })).deletedCount;
    await ReminderLog.deleteMany({ opportunity: opportunity._id });
    await opportunity.deleteOne();
    res.json(await done(req, "permanent.opportunity", `Permanently deleted the opportunity "${opportunity.title}" with ${applications} application(s).`, reason, { type: "opportunity", id: opportunity._id }, { kind: "opportunity", name: opportunity.title, applications, trainingRecords }));
  });

  // An organisation and its partner logins. It must have no opportunities left: delete those first.
  router.delete("/organisations/:id", limiters.login, async (req, res) => {
    const organisation = await Organisation.findById(parseId(req.params.id));
    if (!organisation) throw new ApiError(404, "not_found", "Not found.");
    const { reason } = await confirmed(req, organisation.name);
    if (await Opportunity.exists({ organisation: organisation._id })) {
      throw new ApiError(409, "has_opportunities", "This organisation still has opportunities. Delete them first, or deactivate the organisation instead.");
    }
    const users = await User.find({ organisation: organisation._id, role: "partner" }).select("_id");
    const ids = users.map((u) => u._id);
    if (ids.length > 0) {
      await Session.deleteMany({ user: mongoose.trusted({ $in: ids }) });
      await EmailToken.deleteMany({ user: mongoose.trusted({ $in: ids }) });
      await Notification.deleteMany({ user: mongoose.trusted({ $in: ids }) });
      await User.deleteMany({ _id: mongoose.trusted({ $in: ids }) });
    }
    await organisation.deleteOne();
    res.json(await done(req, "permanent.organisation", `Permanently deleted the organisation "${organisation.name}" and ${ids.length} login(s).`, reason, { type: "organisation", id: organisation._id }, { kind: "organisation", name: organisation.name, logins: ids.length }));
  });

  // A staff account (admin or super admin). Never your own, so at least one super admin (you) always remains.
  router.delete("/admins/:id", limiters.login, async (req, res) => {
    const target = await User.findById(parseId(req.params.id));
    if (!target || (target.role !== "admin" && target.role !== "super_admin")) throw new ApiError(404, "not_found", "Not found.");
    if (String(target._id) === String(req.user._id)) throw new ApiError(409, "cannot_delete_self", "You cannot delete your own account here.");
    const { reason } = await confirmed(req, target.email);
    await Session.deleteMany({ user: target._id });
    await EmailToken.deleteMany({ user: target._id });
    await Notification.deleteMany({ user: target._id });
    await target.deleteOne();
    res.json(await done(req, "permanent.admin", `Permanently deleted the ${target.role === "super_admin" ? "super admin" : "admin"} account of ${target.fullName}.`, reason, { type: "user", id: target._id }, { kind: "admin", name: target.email }));
  });

  // A referral agent. Businesses it brought keep the code as text, so history stays readable.
  router.delete("/agents/:id", limiters.login, async (req, res) => {
    const agent = await Agent.findById(parseId(req.params.id));
    if (!agent) throw new ApiError(404, "not_found", "Not found.");
    const { reason } = await confirmed(req, agent.code);
    const detached = (await Business.updateMany({ "referral.agent": agent._id }, { $set: { "referral.agent": null } })).modifiedCount;
    await agent.deleteOne();
    res.json(await done(req, "permanent.agent", `Permanently deleted the referral agent ${agent.fullName} (${agent.code}).`, reason, { type: "agent", id: agent._id }, { kind: "agent", name: agent.code, businessesDetached: detached }));
  });

  // One application, with its training record. The consent record is ended and kept.
  router.delete("/applications/:id", limiters.login, async (req, res) => {
    const application = await Application.findById(parseId(req.params.id));
    if (!application) throw new ApiError(404, "not_found", "Not found.");
    const name = String(application.snapshot?.businessName ?? "") || "DELETE";
    const { reason } = await confirmed(req, name);
    await endConsents([application._id], "Application deleted by NMREP");
    const trainingRecords = (await TrainingRecord.deleteMany({ application: application._id })).deletedCount;
    await application.deleteOne();
    res.json(await done(req, "permanent.application", `Permanently deleted an application from "${name}".`, reason, { type: "application", id: application._id }, { kind: "application", name, trainingRecords }));
  });

  // A message sent to owners, and the copies in their notification lists.
  router.delete("/broadcasts/:id", limiters.login, async (req, res) => {
    const broadcast = await Broadcast.findById(parseId(req.params.id));
    if (!broadcast) throw new ApiError(404, "not_found", "Not found.");
    const { reason } = await confirmed(req, broadcast.title);
    const notifications = (await Notification.deleteMany({ broadcast: broadcast._id })).deletedCount;
    await broadcast.deleteOne();
    res.json(await done(req, "permanent.broadcast", `Permanently deleted the message "${broadcast.title}" and ${notifications} copy(ies) in owners' lists.`, reason, { type: "broadcast", id: broadcast._id }, { kind: "broadcast", name: broadcast.title, notifications }));
  });

  return router;
}
