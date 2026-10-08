import mongoose from "mongoose";
import { verificationStatuses } from "../options.js";

const str = (max, required = false) => ({ type: String, trim: true, maxlength: max, required, default: required ? undefined : "" });

const businessSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

    // Identity
    businessName: str(120, true),
    tradingName: str(120),
    businessType: str(80, true),
    sector: str(80, true),
    industry: str(120, true),
    yearEstablished: { type: Number, required: true },
    cacNumber: str(30),
    tin: str(30),
    // Location
    state: str(40, true),
    lga: str(80, true),
    city: str(80, true),
    address: str(200, true),
    // Ownership
    ownerName: str(100, true),
    ownerRole: str(40, true),
    ownershipStructure: str(40, true),
    // Operations
    employees: { type: Number, required: true },
    branches: { type: Number, default: null },
    // Financial. Account numbers are deliberately not stored.
    annualRevenue: str(60, true),
    bankName: str(80),
    existingLoans: str(5, true),
    fundingNeeds: str(60),
    // Digital
    website: str(120),
    facebook: str(60),
    instagram: str(60),
    x: str(60),
    tiktok: str(60),

    // Verification. Changed only by the verification process, never by the owner.
    verificationStatus: { type: String, enum: verificationStatuses, default: "Unverified" },
    verificationHistory: [
      {
        _id: false,
        status: { type: String, enum: verificationStatuses, required: true },
        at: { type: Date, default: Date.now },
        note: { type: String, maxlength: 200, default: "" },
      },
    ],
    // Issued after verification. Null until then.
    nmrepId: { type: String, default: null },

    // Who brought this business to NMREP. Set once at registration and never changed by the owner.
    // The code is kept as written at the time, so history stays correct if an agent is later deactivated.
    referral: {
      agent: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", default: null },
      code: { type: String, default: "" },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        ret.owner = String(ret.owner);
        // Owners never see who referred them. Admin routes build their own response.
        delete ret.referral;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

businessSchema.index({ "referral.agent": 1 });
businessSchema.index({ createdAt: -1 });
businessSchema.index({ nmrepId: 1 }, { unique: true, partialFilterExpression: { nmrepId: { $type: "string" } } });

export const Business = mongoose.models.Business ?? mongoose.model("Business", businessSchema);
