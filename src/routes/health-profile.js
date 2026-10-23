import { Router } from "express";
import { buildHealthProfile } from "../lib/health-profile.js";
import { Business } from "../models/Business.js";
import { Document } from "../models/Document.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requireRole } from "../middleware/security.js";

/** The business health profile for the signed-in owner: a checklist of facts, never a score. */
export function healthProfileRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"));

  router.get("/", async (req, res) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    const kinds = await Document.find({ owner: req.user._id }).distinct("kind");
    res.json(buildHealthProfile(business.toJSON(), kinds));
  });

  return router;
}
