import { Router } from "express";
import mongoose from "mongoose";
import { newTemporaryPassword } from "../lib/codes.js";
import { hashPassword } from "../lib/crypto.js";
import { organisationTypes, organisationTypesAvailable } from "../lib/opportunity-constants.js";
import { audit } from "../models/AuditLog.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { idParamSchema } from "../schemas.js";
import { organisationCreateSchema, organisationPatchSchema, partnerUserCreateSchema, partnerUserPatchSchema } from "../schemas-opportunities.js";

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const nameTaken = () =>
  new ApiError(409, "name_taken", "An organisation with this name already exists.", { name: "An organisation with this name already exists." });

/** Organisations and the people who log in for them. Managed by platform admins and the super admin. */
export function adminOrganisationRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  const findOrganisation = async (idValue) => {
    const org = await Organisation.findById(parseId(idValue));
    if (!org) throw new ApiError(404, "not_found", "Not found.");
    return org;
  };

  router.get("/organisation-types", (_req, res) => {
    res.json({ available: organisationTypesAvailable, later: organisationTypes.filter((t) => !organisationTypesAvailable.includes(t)) });
  });

  router.get("/organisations", async (_req, res) => {
    const [orgs, users, opps] = await Promise.all([
      Organisation.find({}).sort({ name: 1 }).collation({ locale: "en", strength: 2 }),
      User.aggregate([{ $match: { role: "partner" } }, { $group: { _id: "$organisation", count: { $sum: 1 } } }]),
      Opportunity.aggregate([{ $match: { organisation: { $ne: null } } }, { $group: { _id: "$organisation", count: { $sum: 1 } } }]),
    ]);
    const userCount = new Map(users.map((r) => [String(r._id), r.count]));
    const oppCount = new Map(opps.map((r) => [String(r._id), r.count]));
    res.json({
      items: orgs.map((o) => ({ ...o.toJSON(), people: userCount.get(String(o._id)) ?? 0, opportunities: oppCount.get(String(o._id)) ?? 0 })),
    });
  });

  router.post("/organisations", async (req, res) => {
    const data = organisationCreateSchema.parse(req.body);
    let org;
    try {
      org = await Organisation.create({ ...data, createdBy: req.user._id });
    } catch (err) {
      if (err?.code === 11000) throw nameTaken();
      throw err;
    }
    await audit(req.user, "organisation.create", `Created organisation "${org.name}" (${org.type})`, { type: "organisation", id: org._id });
    res.status(201).json({ organisation: org.toJSON() });
  });

  router.get("/organisations/:id", async (req, res) => {
    const org = await findOrganisation(req.params.id);
    const [people, byStatus] = await Promise.all([
      User.find({ role: "partner", organisation: org._id }).sort({ createdAt: 1 }),
      Opportunity.aggregate([{ $match: { organisation: org._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);
    res.json({
      organisation: org.toJSON(),
      people: people.map((u) => u.toJSON()),
      opportunities: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
    });
  });

  router.patch("/organisations/:id", async (req, res) => {
    const patch = organisationPatchSchema.parse(req.body);
    const org = await findOrganisation(req.params.id);
    Object.assign(org, patch);
    try {
      await org.save();
    } catch (err) {
      if (err?.code === 11000) throw nameTaken();
      throw err;
    }
    if (patch.active === false) {
      // Everyone at the organisation is signed out at once.
      const ids = await User.find({ role: "partner", organisation: org._id }).distinct("_id");
      await Session.deleteMany({ user: mongoose.trusted({ $in: ids }) });
    }
    const what = patch.active === undefined ? "edited" : patch.active ? "reactivated" : "deactivated";
    await audit(req.user, "organisation.update", `Organisation "${org.name}" ${what}`, { type: "organisation", id: org._id });
    res.json({ organisation: org.toJSON() });
  });

  // ------------------------------------------------------------ partner people
  router.post("/organisations/:id/users", async (req, res) => {
    const org = await findOrganisation(req.params.id);
    const data = partnerUserCreateSchema.parse(req.body);
    if (await User.exists({ email: data.email })) {
      throw new ApiError(409, "email_taken", "An account with this email address already exists.", {
        email: "An account with this email address already exists.",
      });
    }
    // The temporary password is shown once and never stored in readable form.
    const temporaryPassword = newTemporaryPassword();
    const user = await User.create({
      ...data,
      passwordHash: await hashPassword(temporaryPassword, config.bcryptRounds),
      role: "partner",
      organisation: org._id,
      mustChangePassword: true,
      createdBy: req.user._id,
    });
    await audit(req.user, "partner.create", `Created a login for ${user.fullName} at "${org.name}"`, { type: "user", id: user._id });
    res.status(201).json({ user: user.toJSON(), temporaryPassword });
  });

  const partnerUser = async (idValue) => {
    const user = await User.findById(parseId(idValue));
    if (!user || user.role !== "partner") throw new ApiError(404, "not_found", "Not found.");
    return user;
  };

  router.patch("/partner-users/:id", async (req, res) => {
    const { active } = partnerUserPatchSchema.parse(req.body);
    const user = await partnerUser(req.params.id);
    user.active = active;
    await user.save();
    if (!active) await Session.deleteMany({ user: user._id });
    await audit(req.user, "partner.update", `${active ? "Reactivated" : "Deactivated"} the login of ${user.fullName}`, { type: "user", id: user._id });
    res.json({ user: user.toJSON() });
  });

  router.post("/partner-users/:id/reset-password", async (req, res) => {
    const user = await partnerUser(req.params.id);
    const temporaryPassword = newTemporaryPassword();
    user.passwordHash = await hashPassword(temporaryPassword, config.bcryptRounds);
    user.mustChangePassword = true;
    user.failedLogins = 0;
    user.lockUntil = null;
    await user.save();
    await Session.deleteMany({ user: user._id });
    await audit(req.user, "partner.reset-password", `Reset the password of ${user.fullName}`, { type: "user", id: user._id });
    res.json({ user: user.toJSON(), temporaryPassword });
  });

  return router;
}
