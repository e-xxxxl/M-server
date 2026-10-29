import { Router } from "express";
import { Business } from "../models/Business.js";
import { Notification } from "../models/Notification.js";
import { buildInsights } from "../lib/insights.js";
import { countEligible } from "../lib/open-opportunities.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";

export function dashboardRoutes({ config }) {
  const router = Router();

  // Everything the dashboard needs in one request: the account, the business and the insights.
  router.get("/", requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config), async (req, res) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    const unreadNotifications = await Notification.countDocuments({ user: req.user._id, readAt: null });
    // "You may qualify for N current programmes": open opportunities this business meets every Required requirement for.
    const eligibleOpportunities = await countEligible(business, req.user._id);
    res.json({ user: req.user, business, insights: buildInsights(business), unreadNotifications, eligibleOpportunities });
  });

  return router;
}
