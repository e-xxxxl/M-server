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
import { businessPatchSchema, coOwnerCreateSchema, coOwnerPatchSchema } from "../schemas.js";
import { maxCoOwners } from "../lib/co-owners.js";
import { fingerprint, maskValue } from "../lib/verification.js";

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

  // The logo and the owner's photo: one JPEG or PNG each, kept encrypted like the document wallet, seen only by the owner and
  // NMREP staff (the photo only by staff allowed to see personal details).
  const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
  for (const [field, noun] of [["logo", "logo"], ["photo", "photo"]]) {
    router.put(`/${field}`, async (req, res) => {
      if (!documentStorage.enabled) throw new ApiError(503, "images_unavailable", "Pictures are not available right now. Please try again later.");
      const business = await own(req);
      const { buffer, fields } = await readUpload(req, { ...config.documents, maxFileBytes: Math.min(MAX_PICTURE_BYTES, config.documents.maxFileBytes) });
      if (Object.keys(fields).length > 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { _: "Send only the file." });
      const mime = sniffMime(buffer);
      if (mime !== "image/jpeg" && mime !== "image/png") throw new ApiError(422, "unsupported_file", `Upload a JPEG or PNG ${noun}.`, { file: `Upload a JPEG or PNG ${noun}.` });
      const stored = await documentStorage.save(buffer);
      const old = business[field]?.storageKey;
      try {
        business[field] = { mime, size: buffer.length, ...stored };
        await business.save();
      } catch (err) {
        await documentStorage.remove(stored.storageKey);
        throw err;
      }
      if (old) await documentStorage.remove(old);
      res.json({ business, insights: buildInsights(business) });
    });

    router.get(`/${field}`, async (req, res) => {
      const business = await own(req);
      if (!business[field]?.storageKey) throw new ApiError(404, "not_found", "Not found.");
      await sendProductImage(res, business[field]);
    });

    router.delete(`/${field}`, async (req, res) => {
      const business = await own(req);
      if (business[field]?.storageKey) {
        await documentStorage.remove(business[field].storageKey);
        business[field] = undefined;
        await business.save();
      }
      res.status(204).end();
    });
  }

  // Other owners or directors: up to two besides the main owner. Each gives name, role, phone, email and their own NIN, of
  // which only the last four digits and a fingerprint are kept. Not shared with partners.
  const coOwnerView = (business) => business.toJSON().coOwners;
  const ninMarks = (nin) => ({ ninMasked: maskValue(nin), ninHash: String(config.verification.hashKey).length >= 32 ? fingerprint(config, "nin", nin) : "" });
  /** Refuses a NIN that this business already gave for another owner. */
  async function checkNinFree(business, ninHash, exceptId = null) {
    if (!ninHash) return;
    const withHash = await Business.findById(business._id).select("+ninHash");
    const used = [withHash.ninHash, ...business.coOwners.filter((c) => String(c._id) !== String(exceptId)).map((c) => c.ninHash)];
    if (used.includes(ninHash)) throw new ApiError(422, "validation", "Please check the highlighted fields.", { nin: "This NIN is already used for this business." });
  }

  router.get("/co-owners", async (req, res) => {
    res.json({ coOwners: coOwnerView(await own(req)), max: maxCoOwners });
  });

  router.post("/co-owners", async (req, res) => {
    const { nin, consent: _consent, ...data } = coOwnerCreateSchema.parse(req.body);
    const business = await own(req);
    if (business.coOwners.length >= maxCoOwners) {
      throw new ApiError(422, "validation", `A business can list up to ${maxCoOwners} other owners or directors.`, { _: `A business can list up to ${maxCoOwners} other owners or directors.` });
    }
    const marks = ninMarks(nin);
    await checkNinFree(business, marks.ninHash);
    business.coOwners.push({ ...data, ...marks });
    await business.save();
    res.status(201).json({ coOwners: coOwnerView(business), max: maxCoOwners });
  });

  router.patch("/co-owners/:id", async (req, res) => {
    const { nin, consent: _consent, ...data } = coOwnerPatchSchema.parse(req.body);
    const business = await own(req);
    const one = business.coOwners.id(req.params.id);
    if (!one) throw new ApiError(404, "not_found", "Not found.");
    Object.assign(one, data);
    if (nin !== undefined) {
      const marks = ninMarks(nin);
      await checkNinFree(business, marks.ninHash, one._id);
      Object.assign(one, marks);
    }
    await business.save();
    res.json({ coOwners: coOwnerView(business), max: maxCoOwners });
  });

  router.delete("/co-owners/:id", async (req, res) => {
    const business = await own(req);
    const one = business.coOwners.id(req.params.id);
    if (!one) throw new ApiError(404, "not_found", "Not found.");
    one.deleteOne();
    await business.save();
    res.json({ coOwners: coOwnerView(business), max: maxCoOwners });
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
    const hadCac = business.hasCac === "Yes" || Boolean(business.cacNumber);
    Object.assign(business, patch);
    applyComplianceRules(business, patch);
    // Getting a CAC number after joining NMREP means the business has formalised: counted in the impact reports.
    if (!hadCac && !business.formalisedAt && (business.hasCac === "Yes" || business.cacNumber)) business.formalisedAt = new Date();
    await business.save();
    res.json({ business, insights: buildInsights(business) });
  });

  return router;
}
