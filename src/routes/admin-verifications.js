import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { Business } from "../models/Business.js";
import { User } from "../models/User.js";
import { VerificationCheck } from "../models/VerificationCheck.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";
import { verificationStatuses } from "../options.js";
import { checkTypes, duplicatesOf, verificationEnabled } from "../lib/verification.js";

const querySchema = z
  .object({
    status: z.enum([...verificationStatuses, "all"]).default("Pending Verification"),
    q: z.string().trim().max(80).default(""),
  })
  .strict();

/**
 * The verification queue for NMREP staff: each business with where it stands (status, the NIN and CAC checks, the
 * documents it chose to show reviewers), so a reviewer can see what is ready before opening the business.
 * Names and numbers from the official records are never kept, so none are shown: only outcomes and comparisons.
 */
export function adminVerificationRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  router.get("/", async (req, res) => {
    const { status, q } = querySchema.parse(req.query);
    const match = {};
    if (status !== "all") match.verificationStatus = status;
    // The search text is escaped, so it can only ever match as plain text.
    if (q) match.businessName = mongoose.trusted({ $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" });

    const [counts, businesses] = await Promise.all([
      Business.aggregate([{ $group: { _id: "$verificationStatus", count: { $sum: 1 } } }]),
      Business.find(match).sort({ updatedAt: -1 }).limit(200),
    ]);
    const ids = businesses.map((b) => b._id);
    const [checks, submissions, owners] = await Promise.all([
      VerificationCheck.find({ business: mongoose.trusted({ $in: ids }), type: mongoose.trusted({ $in: checkTypes }) }).sort({ checkedAt: -1 }),
      VerificationSubmission.find({ business: mongoose.trusted({ $in: ids }) }).lean(),
      User.find({ _id: mongoose.trusted({ $in: businesses.map((b) => b.owner) }) }).select("fullName email phone").lean(),
    ]);
    const latest = new Map();
    for (const c of checks) {
      const key = `${c.business}:${c.type}`;
      if (!latest.has(key)) latest.set(key, c);
    }
    const docsOf = new Map(submissions.map((s) => [String(s.business), s.documents.length]));
    const ownerOf = new Map(owners.map((o) => [String(o._id), o]));

    const brief = async (c) =>
      c
        ? {
            status: c.status,
            checkedAt: c.checkedAt,
            nameMatch: c.nameMatch,
            phoneMatch: c.phoneMatch,
            registeredName: c.registeredName,
            companyStatus: c.companyStatus,
            otherBusinessesWithSameNumber: await duplicatesOf(c),
          }
        : null;

    const items = [];
    for (const b of businesses) {
      const owner = ownerOf.get(String(b.owner));
      items.push({
        id: String(b._id),
        businessName: b.businessName,
        businessType: b.businessType,
        state: b.state,
        verificationStatus: b.verificationStatus,
        nmrepId: b.nmrepId,
        updatedAt: b.updatedAt,
        createdAt: b.createdAt,
        ownerName: owner?.fullName ?? b.ownerName,
        ownerEmail: owner?.email ?? "",
        ownerPhone: owner?.phone ?? "",
        hasCac: b.hasCac,
        cacNumber: b.cacNumber,
        ninGiven: Boolean(b.ninMasked),
        ninMasked: b.ninMasked,
        nin: await brief(latest.get(`${b._id}:nin`)),
        cac: await brief(latest.get(`${b._id}:cac`)),
        documentsShared: docsOf.get(String(b._id)) ?? 0,
        lastNote: b.verificationHistory?.at(-1)?.note ?? "",
        lastChangedAt: b.verificationHistory?.at(-1)?.at ?? null,
      });
    }

    res.json({
      automatedChecksAvailable: verificationEnabled(config),
      counts: Object.fromEntries(verificationStatuses.map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0])),
      items,
    });
  });

  return router;
}
