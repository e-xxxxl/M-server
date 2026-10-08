import mongoose from "mongoose";

/**
 * A staff member or field agent ("foot soldier") who brings businesses to NMREP.
 * Agents do not log in. Admins create them, which generates their referral code, and the
 * number of registrants brought in is counted from businesses that carry that code.
 */
const agentSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    notes: { type: String, trim: true, maxlength: 300, default: "" },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    // A deactivated code is rejected at registration. Past registrations stay attributed.
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.createdBy;
        return ret;
      },
    },
  },
);

export const Agent = mongoose.models.Agent ?? mongoose.model("Agent", agentSchema);
