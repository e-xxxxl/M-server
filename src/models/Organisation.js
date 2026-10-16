import mongoose from "mongoose";
import { organisationTypes } from "../lib/opportunity-constants.js";

/** A partner: an agency, bank or other organisation with its own logins and its own opportunities. */
const organisationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: organisationTypes, required: true },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    // An inactive organisation's people cannot log in and its opportunities are hidden.
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        ret.createdBy = String(ret.createdBy);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

organisationSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Organisation = mongoose.models.Organisation ?? mongoose.model("Organisation", organisationSchema);
