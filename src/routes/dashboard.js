import { Router } from "express";
import { Business } from "../models/Business.js";
import { Notification } from "../models/Notification.js";
import { buildInsights } from "../lib/insights.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requireRole } from "../middleware/security.js";

export function dashboardRoutes({ config }) {
  const router = Router();

  // Everything the dashboard needs in one request: the account, the business and the insights.
  router.get("/", requireAuth(config), requireRole("msme_owner"), async (req, res) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    const unreadNotifications = await Notification.countDocuments({ user: req.user._id, readAt: null });
    res.json({ user: req.user, business, insights: buildInsights(business), unreadNotifications });
  });

  return router;
}
