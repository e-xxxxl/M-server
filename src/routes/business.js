import { Router } from "express";
import { documentStorage } from "../lib/document-storage.js";
import { readUpload, sniffMime } from "../lib/documents.js";
import { sendProductImage } from "./products.js";
import { Business } from "../models/Business.js";
import { applyComplianceRules } from "../lib/compliance.js";
import { buildInsights } from "../lib/insights.js";
import { checkLocation } from "../lib/lgas.js";
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

  // The logo: one JPEG or PNG, kept encrypted like the document wallet, seen only by the owner and NMREP staff.
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;
  router.put("/logo", async (req, res) => {
    if (!documentStorage.enabled) throw new ApiError(503, "images_unavailable", "Pictures are not available right now. Please try again later.");
    const business = await own(req);
    const { buffer, fields } = await readUpload(req, { ...config.documents, maxFileBytes: Math.min(MAX_LOGO_BYTES, config.documents.maxFileBytes) });
    if (Object.keys(fields).length > 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { _: "Send only the file." });
    const mime = sniffMime(buffer);
    if (mime !== "image/jpeg" && mime !== "image/png") throw new ApiError(422, "unsupported_file", "Upload a JPEG or PNG picture.", { file: "Upload a JPEG or PNG picture." });
    const stored = await documentStorage.save(buffer);
    const old = business.logo?.storageKey;
    try {
      business.logo = { mime, size: buffer.length, ...stored };
      await business.save();
    } catch (err) {
      await documentStorage.remove(stored.storageKey);
      throw err;
    }
    if (old) await documentStorage.remove(old);
    res.json({ business, insights: buildInsights(business) });
  });

  router.get("/logo", async (req, res) => {
    const business = await own(req);
    if (!business.logo?.storageKey) throw new ApiError(404, "not_found", "Not found.");
    await sendProductImage(res, business.logo);
  });

  router.delete("/logo", async (req, res) => {
    const business = await own(req);
    if (business.logo?.storageKey) {
      await documentStorage.remove(business.logo.storageKey);
      business.logo = undefined;
      await business.save();
    }
    res.status(204).end();
  });

  router.patch("/", async (req, res) => {
    const patch = businessPatchSchema.parse(req.body);
    if (Object.keys(patch).length === 0) {
      throw new ApiError(422, "validation", "Nothing to update.", { _: "Nothing to update." });
    }
    const business = await own(req);
    // Changing the state or the area: the area must belong to the state (a stored area that no longer fits has to be chosen again).
    if (patch.state !== undefined || patch.lga !== undefined) {
      patch.lga = await checkLocation({ state: patch.state ?? business.state, lga: patch.lga ?? business.lga });
    }
    Object.assign(business, patch);
    applyComplianceRules(business, patch);
    await business.save();
    res.json({ business, insights: buildInsights(business) });
  });

  return router;
}
