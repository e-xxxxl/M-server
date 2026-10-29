import { Router } from "express";
import { Business } from "../models/Business.js";
import { applyComplianceRules } from "../lib/compliance.js";
import { buildInsights } from "../lib/insights.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { businessPatchSchema } from "../schemas.js";

export function businessRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));

  // A user can only ever reach their own business: it is always looked up by the session's user.
  const own = async (req) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    return business;
  };

  router.get("/", async (req, res) => {
    const business = await own(req);
    res.json({ business, insights: buildInsights(business) });
  });

  router.patch("/", async (req, res) => {
    const patch = businessPatchSchema.parse(req.body);
    if (Object.keys(patch).length === 0) {
      throw new ApiError(422, "validation", "Nothing to update.", { _: "Nothing to update." });
    }
    const business = await own(req);
    Object.assign(business, patch);
    applyComplianceRules(business, patch);
    await business.save();
    res.json({ business, insights: buildInsights(business) });
  });

  return router;
}
