import mongoose from "mongoose";
import { assessmentResults } from "../lib/opportunity-constants.js";

/**
 * What happened to one participant in one training: attendance per session, the assessment, completion and the
 * certificate. A participant is a business whose application to a Training opportunity was approved, so there is
 * at most one record per application. It holds no profile data: names come from the application and the account.
 */
const trainingRecordSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: "Application", required: true, unique: true },
    opportunity: { type: mongoose.Schema.Types.ObjectId, ref: "Opportunity", required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // One entry per session the provider has marked, present or absent. A session never marked is "not recorded".
    attendance: [
      {
        _id: false,
        session: { type: mongoose.Schema.Types.ObjectId, required: true },
        present: { type: Boolean, required: true },
        at: { type: Date, default: Date.now },
      },
    ],
    assessment: {
      result: { type: String, enum: [...assessmentResults, null], default: null },
      // Optional, 0 to 100. A result can be recorded without a score.
      score: { type: Number, min: 0, max: 100, default: null },
      note: { type: String, trim: true, maxlength: 200, default: "" },
      at: { type: Date, default: null },
    },
    completedAt: { type: Date, default: null },
    certificate: {
      code: { type: String, default: undefined },
      issuedAt: { type: Date, default: undefined },
    },
  },
  { timestamps: true },
);

// A certificate code is unique, and only records that have one are indexed.
trainingRecordSchema.index({ "certificate.code": 1 }, { unique: true, partialFilterExpression: { "certificate.code": { $type: "string" } } });

export const TrainingRecord = mongoose.models.TrainingRecord ?? mongoose.model("TrainingRecord", trainingRecordSchema);
