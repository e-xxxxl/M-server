import { DocumentAccess } from "../models/DocumentAccess.js";
import { notify } from "../models/Notification.js";
import mongoose from "mongoose";
import { ApiError } from "../middleware/errors.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Document, documentKinds, sensitiveKinds } from "../models/Document.js";
import { documentStorage } from "./document-storage.js";

/**
 * The document wallet (framework section 15). An owner keeps documents once and chooses which to attach to an
 * application; an organisation sees only the documents attached to an application of theirs, only while the owner's
 * sharing agreement for it is active (see lib/sharing.js), and every download by staff is written to the audit log.
 */

const EXTENSION = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/** The kind of file from its first bytes. The name and the type the client claims are never trusted. */
export function sniffMime(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

const tooLarge = (mb) => new ApiError(413, "file_too_large", `This file is too large. The limit is ${mb} MB.`, { file: `This file is too large. The limit is ${mb} MB.` });

/** Reads the request body, stopping as soon as it is bigger than `limit` bytes. */
async function readBody(req, limit, mb) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw tooLarge(mb);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw tooLarge(mb);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a multipart/form-data upload with the parts `file`, `kind` and `title`, using the multipart reader built into
 * Node, so no extra package is involved. The whole body is capped (the file limit plus a little for the form fields).
 */
export async function readUpload(req, settings) {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) {
    throw new ApiError(415, "unsupported_media", "Send the file as multipart form data with the parts file, kind and title.");
  }
  const mb = Math.floor(settings.maxFileBytes / (1024 * 1024));
  const body = await readBody(req, settings.maxFileBytes + 64 * 1024, mb);
  let form;
  try {
    form = await new Response(body, { headers: { "content-type": type } }).formData();
  } catch {
    throw new ApiError(400, "bad_upload", "The upload could not be read.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    throw new ApiError(422, "validation", "Please check the highlighted fields.", { file: "Choose a file." });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) throw new ApiError(422, "validation", "Please check the highlighted fields.", { file: "This file is empty." });
  if (buffer.length > settings.maxFileBytes) throw tooLarge(mb);
  if (form.getAll("file").length > 1) throw new ApiError(422, "validation", "Please check the highlighted fields.", { file: "Send one file at a time." });
  // Every other part is a form field. They are all passed on, so the schema can refuse any it does not know.
  const fields = {};
  for (const [name, value] of form.entries()) if (name !== "file") fields[name] = typeof value === "string" ? value : "";
  return { buffer, fields };
}

/** The download name: the title made safe, with the right extension. Never anything from the client's file name. */
export function downloadName(doc) {
  const safe = doc.title.replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "document";
  return `${safe}.${EXTENSION[doc.mime]}`;
}

/** How many days before the end of a share the owner is warned (and offered to extend it). */
export const DOCUMENT_WARNING_DAYS = 3;

/** True while an agreement is really sharing its documents: not ended, has documents, and the end date has not passed. */
export function documentsSharingNow(consent, now = new Date()) {
  if (!consent || consent.revokedAt) return false;
  if (!consent.categories.includes("documents") || consent.documents.length === 0) return false;
  return !consent.documentsExpireAt || consent.documentsExpireAt > now;
}

/** Who each of these documents is currently shared with (active agreements only), keyed by document id. */
export async function sharesOf(documentIds) {
  const consents = await ConsentRecord.find({ revokedAt: null, documents: mongoose.trusted({ $in: documentIds }) }).sort({ grantedAt: -1 });
  const shares = new Map();
  for (const c of consents) {
    if (!documentsSharingNow(c)) continue;
    for (const id of c.documents) {
      const key = String(id);
      if (!documentIds.some((d) => String(d) === key)) continue;
      const list = shares.get(key) ?? [];
      list.push({ application: String(c.application), with: c.sharedWith, purpose: c.purpose, since: c.grantedAt, until: c.documentsExpireAt ?? null });
      shares.set(key, list);
    }
  }
  return shares;
}

/** A document as its owner sees it, with who is sharing it now and the last few times someone else opened it. */
export function ownerView(doc, shares = [], opened = []) {
  return { ...doc.toJSON(), sensitive: sensitiveKinds.includes(doc.kind), sharedWith: shares, opened };
}

/** The last few times each of these documents was opened by an organisation or NMREP, newest first, keyed by document id. */
export async function opensOf(documentIds, perDocument = 5) {
  const rows = await DocumentAccess.find({ document: mongoose.trusted({ $in: documentIds }) }).sort({ at: -1 }).limit(Math.max(1, documentIds.length) * perDocument * 2);
  const opens = new Map();
  for (const r of rows) {
    const key = String(r.document);
    const list = opens.get(key) ?? [];
    if (list.length < perDocument) list.push({ by: r.by, purpose: r.purpose, at: r.at });
    opens.set(key, list);
  }
  return opens;
}

/**
 * Records that someone opened a document, and tells the owner. The owner is told once a day at most for the same
 * organisation and document, so reading a file twice does not send two notices. The notice names the organisation and
 * the kind of document, never its title; a sensitive kind is only called "one of your documents", because a notification
 * can appear on a lock screen.
 */
export async function recordOpen(doc, { by, purpose, application = null }) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const told = await DocumentAccess.exists({ document: doc._id, by, at: mongoose.trusted({ $gte: dayAgo }) });
  await DocumentAccess.create({ document: doc._id, owner: doc.owner, by, purpose, application });
  if (told) return;
  const what = sensitiveKinds.includes(doc.kind) ? "one of your documents" : `your ${doc.kind}`;
  await notify(doc.owner, { type: "application", title: `${by} opened ${what}`.slice(0, 120), body: "", link: "/dashboard/documents/" });
}

/** A document as an organisation or staff member sees it: what it is, never who it is stored under. */
export function sharedView(doc) {
  return { id: String(doc._id), kind: doc.kind, title: doc.title, mime: doc.mime, size: doc.size, sensitive: sensitiveKinds.includes(doc.kind) };
}

export const kindsInfo = () => documentKinds.map((kind) => ({ kind, sensitive: sensitiveKinds.includes(kind) }));

/**
 * The documents an organisation (or staff member) may see for one application: those attached at submission, and only
 * while the owner's sharing agreement for it is active and includes documents. Empty otherwise.
 */
export async function visibleDocuments(application) {
  const consent = await ConsentRecord.findOne({ application: application._id, revokedAt: null }).sort({ grantedAt: -1 });
  if (!documentsSharingNow(consent)) return [];
  const docs = await Document.find({ _id: mongoose.trusted({ $in: consent.documents }), owner: application.owner });
  return docs;
}

/** Sends the decrypted file as a download. A missing or altered file is a plain 404. */
export async function sendDocument(res, doc) {
  let bytes;
  try {
    bytes = await documentStorage.read(doc);
  } catch {
    throw new ApiError(404, "not_found", "Not found.");
  }
  res.set({
    "Content-Type": doc.mime,
    "Content-Disposition": `attachment; filename="${downloadName(doc)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(bytes.length),
  });
  res.end(bytes);
}

export { Document };
