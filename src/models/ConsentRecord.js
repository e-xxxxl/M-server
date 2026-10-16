import mongoose from "mongoose";

/**
 * A record of what a business owner agreed to share, with whom, why and when (framework section 17).
 * One record is written each time an application is submitted. It is ended when the application is withdrawn.
 */
const consentSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  application: { type: mongoose.Schema.Types.ObjectId, ref: "Application", required: true },
  opportunity: { type: mongoose.Schema.Types.ObjectId, ref: "Opportunity", required: true },
  // The organisation that receives the information. Null means NMREP itself (a platform run opportunity).
  organisation: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
  // Kept as text so the record still reads correctly if the organisation or opportunity is renamed.
  sharedWith: { type: String, required: true, maxlength: 120 },
  purpose: { type: String, required: true, maxlength: 200 },
  // "summary", "contact" and "profile". See lib/sharing.js for exactly which fields each one covers.
  categories: { type: [String], required: true },
  grantedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, maxlength: 100, default: "" },
});

consentSchema.index({ owner: 1, grantedAt: -1 });
consentSchema.index({ application: 1, grantedAt: -1 });
consentSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    ret.application = String(ret.application);
    ret.opportunity = String(ret.opportunity);
    delete ret._id;
    delete ret.__v;
    delete ret.owner;
    delete ret.business;
    delete ret.organisation;
    return ret;
  },
});

export const ConsentRecord = mongoose.models.ConsentRecord ?? mongoose.model("ConsentRecord", consentSchema);
