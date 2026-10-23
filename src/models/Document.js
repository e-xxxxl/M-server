import mongoose from "mongoose";

/** What a document is. The first six are the framework's own examples. "ID" and "Bank Statement" are sensitive. */
export const documentKinds = ["CAC Certificate", "Tax Clearance", "Business Licence", "ID", "Bank Statement", "Audited Accounts", "Other"];
export const sensitiveKinds = ["ID", "Bank Statement"];

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
