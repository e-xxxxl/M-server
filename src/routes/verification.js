import { Router } from "express";
import { Business } from "../models/Business.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { verificationCheckSchema } from "../schemas.js";
import { applicability, checkInfo, checkTypes, latestChecks, ownerView, runCheck, verificationEnabled } from "../lib/verification.js";

/** Automated checks for the business owner: what can be checked, the latest results, and running a check. */
export function verificationRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"));

  const ownBusiness = async (req) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    return business;
  };

  router.get("/", async (req, res) => {
    const business = await ownBusiness(req);
    const latest = new Map((await latestChecks(business._id)).map((c) => [c.type, c]));
    res.json({
      available: verificationEnabled(config),
      verificationStatus: business.verificationStatus,
      checks: checkTypes.map((type) => {
        const check = latest.get(type);
        const reason = applicability(type, business);
        return {
          type,
          label: checkInfo[type].label,
          description: checkInfo[type].description,
          needsNumber: checkInfo[type].needsNumber,
          applicable: reason === "",
          reason,
          result: check ? ownerView(check) : null,
        };
      }),
    });
  });

  router.post("/checks", async (req, res) => {
    const input = verificationCheckSchema.parse(req.body);
    const business = await ownBusiness(req);
    const check = await runCheck({ config, business, user: req.user, input });
    res.status(201).json({ check: ownerView(check), verificationStatus: business.verificationStatus });
  });

  return router;
}
