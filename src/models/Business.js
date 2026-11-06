import mongoose from "mongoose";
import { verificationStatuses } from "../options.js";

/** A business's size from its number of employees (the usual MSME bands): micro 1 to 9, small 10 to 49, medium 50 to 199. */
export function businessSizeOf(employees) {
  const n = Number(employees);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 10) return "Micro";
  if (n < 50) return "Small";
  if (n < 200) return "Medium";
  return "Large";
}

const money = { type: Number, default: null, min: 0, max: 10_000_000_000 };

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
    hasCac: str(3),
    cacNumber: str(30),
    hasTin: str(3),
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
    // The owner's NIN is asked at sign-up and checked once. Only the last four digits and a keyed fingerprint are kept, never the number.
    // Set when the business was Suspended because its subscription ended and was not renewed. Renewing restores the status it had.
    suspendedForSubscription: { type: Boolean, default: false },
    statusBeforeSuspension: { type: String, default: "" },
    ninMasked: { type: String, maxlength: 20, default: "" },
    ninHash: { type: String, maxlength: 64, default: "", select: false },
    // More about the business. Optional, and not counted in the profile progress.
    description: str(500),
    monthlyRevenue: money,
    assetsValue: money,
    // Training: what the business needs help with, how it likes to learn, and what interests it.
    skillGaps: { type: [String], default: [] },
    preferredFormat: str(20),
    interests: { type: [String], default: [] },
    // The logo is an encrypted file in the private document folder. Only facts about it are kept here.
    logo: {
      type: new mongoose.Schema({ mime: { type: String, enum: ["image/jpeg", "image/png"], required: true }, size: Number, storageKey: String, iv: String, tag: String }, { _id: false }),
      default: undefined,
    },
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
        // Never the storage details of the logo: only what a screen needs to ask for it.
        ret.logo = ret.logo?.storageKey ? { mime: ret.logo.mime, size: ret.logo.size } : null;
        ret.businessSize = businessSizeOf(ret.employees);
        ret.ninProvided = Boolean(ret.ninMasked);
        delete ret.ninHash;
        delete ret.suspendedForSubscription;
        delete ret.statusBeforeSuspension;
        // Profiles saved before the Yes or No questions existed: a number on file means Yes.
        if (!ret.hasCac && ret.cacNumber) ret.hasCac = "Yes";
        if (!ret.hasTin && ret.tin) ret.hasTin = "Yes";
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
