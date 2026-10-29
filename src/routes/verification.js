import { Router } from "express";
import { Business } from "../models/Business.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { Document } from "../models/Document.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";
import { documentStorage } from "../lib/document-storage.js";
import { ownerDocumentsView } from "../lib/verification-documents.js";
import { verificationCheckSchema, verificationDocumentsSchema } from "../schemas.js";
import mongoose from "mongoose";
import { applicability, checkInfo, checkTypes, latestChecks, ownerView, runCheck, verificationEnabled } from "../lib/verification.js";

/** Automated checks for the business owner: what can be checked, the latest results, and running a check. */
export function verificationRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));

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
      documents: await ownerDocumentsView(business),
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

  // The document check: choose which wallet documents NMREP's reviewers may open. An empty list stops the sharing.
  router.put("/documents", async (req, res) => {
    const { documentIds, agree } = verificationDocumentsSchema.parse(req.body);
    const business = await ownBusiness(req);
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) {
      await VerificationSubmission.deleteOne({ business: business._id });
      return res.json({ documents: await ownerDocumentsView(business), verificationStatus: business.verificationStatus });
    }
    if (!documentStorage.enabled) throw new ApiError(503, "documents_unavailable", "Documents are not available right now. Please try again later.");
    if (agree !== true) {
      throw new ApiError(422, "consent_required", "Please agree to show these documents to NMREP's reviewers.", { agree: "Tick the box to show these documents to NMREP's reviewers." });
    }
    const owned = new Set((await Document.find({ _id: mongoose.trusted({ $in: ids }), owner: req.user._id }).select("_id")).map((d) => String(d._id)));
    const missing = ids.findIndex((id) => !owned.has(id));
    if (missing >= 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`documentIds.${missing}`]: "This document is not in your wallet." });

    await VerificationSubmission.findOneAndUpdate(
      { business: business._id },
      { $set: { owner: req.user._id, documents: ids, submittedAt: new Date() } },
      { upsert: true },
    );
    // Sending documents for review puts an unverified business in the reviewers' queue.
    if (business.verificationStatus === "Unverified") {
      business.verificationStatus = "Pending Verification";
      business.verificationHistory.push({ status: "Pending Verification", at: new Date(), note: "Documents were sent for review" });
      await business.save();
    }
    res.json({ documents: await ownerDocumentsView(business), verificationStatus: business.verificationStatus });
  });

  router.post("/checks", async (req, res) => {
    const input = verificationCheckSchema.parse(req.body);
    const business = await ownBusiness(req);
    const check = await runCheck({ config, business, user: req.user, input });
    res.status(201).json({ check: ownerView(check), verificationStatus: business.verificationStatus });
  });

  return router;
}
