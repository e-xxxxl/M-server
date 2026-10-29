import mongoose from "mongoose";

/**
 * What a document is: the nine of the Data Collection Modules (CAC certificate, TIN certificate, tax clearance, utility
 * bill, bank statement, means of identification, business plan, product catalog, audited accounts) plus the framework's
 * business licence, and "Other". "ID", "Bank Statement" and "Utility Bill" (it shows a home address) are sensitive.
 */
export const documentKinds = [
  "CAC Certificate",
  "TIN Certificate",
  "Tax Clearance",
  "Business Licence",
  "ID",
  "Utility Bill",
  "Bank Statement",
  "Business Plan",
  "Product Catalog",
  "Audited Accounts",
  "Other",
];
export const sensitiveKinds = ["ID", "Bank Statement", "Utility Bill"];

/**
 * One document in an owner's wallet. The file itself is not in the database: it is encrypted and stored in a private
 * folder under a random name, and only that name, the encryption details and a few facts about the file are kept here.
 * The name the owner's device gave the file is never kept.
 */
const documentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    kind: { type: String, enum: documentKinds, required: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    // Decided from the first bytes of the file, never from what the client claimed.
    mime: { type: String, enum: ["application/pdf", "image/jpeg", "image/png"], required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    // Random 32 hex characters. The only thing used to build the path on disk.
    storageKey: { type: String, required: true, unique: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        // Storage and encryption details never leave the server.
        for (const k of ["_id", "__v", "owner", "business", "sha256", "storageKey", "iv", "tag"]) delete ret[k];
        return ret;
      },
    },
  },
);

export const Document = mongoose.models.Document ?? mongoose.model("Document", documentSchema);
