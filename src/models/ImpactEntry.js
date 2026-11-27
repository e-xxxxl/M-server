import mongoose from "mongoose";

/**
 * What a business reports about its impact for one year: the jobs it created. Entered by the owner, or by the super admin
 * on the owner's behalf. Nothing about funding is recorded. Other impact figures (opportunities accessed, programme
 * attendees, certificates, businesses formalised) are counted from what already happens on the platform, not typed in.
 */
const impactSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    jobsCreated: { type: Number, required: true, min: 0, max: 100000 },
    // "owner" or "admin" (the super admin), and who, so a figure can always be traced.
    enteredBy: { type: String, enum: ["owner", "admin"], required: true },
    enteredByName: { type: String, default: "", maxlength: 100 },
  },
  { timestamps: true },
);

impactSchema.index({ business: 1, year: 1 }, { unique: true });
impactSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    ret.business = String(ret.business);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ImpactEntry = mongoose.models.ImpactEntry ?? mongoose.model("ImpactEntry", impactSchema);
