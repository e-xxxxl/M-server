import mongoose from "mongoose";

export const checkTypes = ["nin", "bvn", "cac", "tin"];
export const checkStatuses = ["Passed", "Needs review", "Not found"];

/**
 * The record of one automated check. It holds the outcome and only what a reviewer needs to judge it:
 * - a masked number (last four digits) and a keyed fingerprint (HMAC), never the NIN or BVN itself;
 * - whether the names (and, for NIN and BVN, the phone number) matched, never the names themselves, except the
 *   public company name from the CAC register;
 * - the provider's reference, so a result can be queried with the provider.
 * Everything else the provider returns is dropped before it reaches the database.
 */
const checkSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: checkTypes, required: true },
    status: { type: String, enum: checkStatuses, required: true },
    maskedValue: { type: String, maxlength: 20, default: "" },
    valueHash: { type: String, maxlength: 64, required: true },
    nameMatch: { type: Boolean, default: null },
    phoneMatch: { type: Boolean, default: null },
    // CAC only: public register data.
    registeredName: { type: String, maxlength: 200, default: "" },
    companyStatus: { type: String, maxlength: 40, default: "" },
    reference: { type: String, maxlength: 80, default: "" },
    // NIN and BVN: when the owner agreed to the check.
    consentAt: { type: Date, default: null },
    checkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

checkSchema.index({ business: 1, type: 1, checkedAt: -1 });
checkSchema.index({ type: 1, valueHash: 1 });

export const VerificationCheck = mongoose.models.VerificationCheck ?? mongoose.model("VerificationCheck", checkSchema);
