import mongoose from "mongoose";

/**
 * Each time someone other than the owner opens one of the owner's documents: an organisation reading an attached
 * document, or NMREP staff reading a document for an application or a verification. Kept so the owner can see who has
 * opened what, and when. It holds no file content and no personal details of the person who opened it, only the name of
 * the organisation (or NMREP) as text.
 */
const documentAccessSchema = new mongoose.Schema({
  document: { type: mongoose.Schema.Types.ObjectId, ref: "Document", required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // "NMREP" or the organisation's name, kept as text so it reads correctly if the organisation is renamed.
  by: { type: String, required: true, maxlength: 120 },
  purpose: { type: String, enum: ["Application", "Verification"], required: true },
  application: { type: mongoose.Schema.Types.ObjectId, ref: "Application", default: null },
  at: { type: Date, default: Date.now, index: true },
});

export const DocumentAccess = mongoose.models.DocumentAccess ?? mongoose.model("DocumentAccess", documentAccessSchema);
