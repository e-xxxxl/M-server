import mongoose from "mongoose";
import { Document } from "../models/Document.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";
import { documentStorage } from "./document-storage.js";
import { sharedView } from "./documents.js";

/** The kinds of document that help a reviewer most. The owner may choose any document in the wallet. */
export const suggestedKinds = ["CAC Certificate", "ID", "TIN Certificate", "Tax Clearance", "Utility Bill"];

/** The documents shared with reviewers now: the ones chosen, that still exist and belong to the owner. */
export async function submittedDocuments(business) {
  const submission = await VerificationSubmission.findOne({ business: business._id });
  if (!submission || submission.documents.length === 0) return { submission: null, documents: [] };
  const documents = await Document.find({ _id: mongoose.trusted({ $in: submission.documents }), owner: business.owner });
  return { submission, documents };
}

/** What the owner sees on the Verification page. */
export async function ownerDocumentsView(business) {
  const { submission, documents } = await submittedDocuments(business);
  return {
    available: documentStorage.enabled,
    suggestedKinds,
    shared: documents.map(sharedView),
    sharedAt: submission && documents.length > 0 ? submission.submittedAt : null,
  };
}
