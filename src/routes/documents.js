import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { documentStorage } from "../lib/document-storage.js";
import { kindsInfo, ownerView, readUpload, sendDocument, sharesOf, sniffMime } from "../lib/documents.js";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Document, documentKinds } from "../models/Document.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { idParamSchema, oneOf, optionalText } from "../schemas.js";

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const uploadFieldsSchema = z.object({ kind: oneOf(documentKinds), title: optionalText(100).default("") }).strict();

/** The owner's document wallet: list, upload, download and delete. */
export function documentRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));
  const limits = () => ({
    maxFileMb: Math.floor(config.documents.maxFileBytes / (1024 * 1024)),
    maxFiles: config.documents.maxFiles,
    maxTotalMb: Math.floor(config.documents.maxTotalBytes / (1024 * 1024)),
    types: ["PDF", "JPEG", "PNG"],
  });

  router.get("/", async (req, res) => {
    const docs = await Document.find({ owner: req.user._id }).sort({ createdAt: -1 });
    const shares = await sharesOf(docs.map((d) => d._id));
    res.json({
      available: documentStorage.enabled,
      limits: limits(),
      kinds: kindsInfo(),
      items: docs.map((d) => ownerView(d, shares.get(String(d._id)) ?? [])),
    });
  });

  router.post("/", async (req, res) => {
    if (!documentStorage.enabled) throw new ApiError(503, "documents_unavailable", "Documents are not available right now. Please try again later.");
    const business = await Business.findOne({ owner: req.user._id }).select("_id");
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");

    const { buffer, fields } = await readUpload(req, config.documents);
    const { kind, title } = uploadFieldsSchema.parse(fields);
    const mime = sniffMime(buffer);
    if (!mime) throw new ApiError(422, "unsupported_file", "Upload a PDF, JPEG or PNG file.", { file: "Upload a PDF, JPEG or PNG file." });

    const existing = await Document.find({ owner: req.user._id }).select("size");
    const total = existing.reduce((n, d) => n + d.size, 0);
    if (existing.length >= config.documents.maxFiles) {
      throw new ApiError(422, "document_limit", `You can keep up to ${config.documents.maxFiles} documents. Delete one to add another.`);
    }
    if (total + buffer.length > config.documents.maxTotalBytes) {
      throw new ApiError(422, "document_limit", `Your documents are over ${limits().maxTotalMb} MB in total. Delete one to add another.`);
    }

    const stored = await documentStorage.save(buffer);
    try {
      const doc = await Document.create({
        owner: req.user._id,
        business: business._id,
        kind,
        title: title || kind,
        mime,
        size: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        ...stored,
      });
      res.status(201).json({ document: ownerView(doc) });
    } catch (err) {
      await documentStorage.remove(stored.storageKey); // do not leave an unreferenced file behind
      throw err;
    }
  });

  router.get("/:id/file", async (req, res) => {
    const doc = await Document.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!doc) throw new ApiError(404, "not_found", "Not found.");
    await sendDocument(res, doc);
  });

  router.delete("/:id", async (req, res) => {
    const doc = await Document.findOne({ _id: parseId(req.params.id), owner: req.user._id });
    if (!doc) throw new ApiError(404, "not_found", "Not found.");
    await documentStorage.remove(doc.storageKey);
    await doc.deleteOne();
    // A deleted document can no longer be seen by anyone it was shared with.
    await Application.updateMany({ owner: req.user._id }, { $pull: { documents: doc._id } });
    await ConsentRecord.updateMany({ owner: req.user._id }, { $pull: { documents: doc._id } });
    await VerificationSubmission.updateMany({ owner: req.user._id }, { $pull: { documents: doc._id } });
    res.status(204).end();
  });

  return router;
}
