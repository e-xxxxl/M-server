import mongoose from "mongoose";
import { applicationStatuses } from "../lib/opportunity-constants.js";

const applicationSchema = new mongoose.Schema(
  {
    opportunity: { type: mongoose.Schema.Types.ObjectId, ref: "Opportunity", required: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: applicationStatuses, default: "Draft" },
    message: { type: String, trim: true, maxlength: 500, default: "" },
    // A copy of the business profile at the moment of submission, so later edits cannot change what reviewers see.
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    submittedAt: { type: Date, default: null },
    // Documents from the owner's wallet that were attached when this was submitted. Only visible to the
    // organisation while the sharing agreement for this application is active (see ConsentRecord).
    documents: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // The applicant's answers to the opportunity's questions. The question text is copied so later edits do not change it.
    answers: {
      type: [{ _id: false, question: { type: mongoose.Schema.Types.ObjectId, required: true }, text: { type: String, default: "" }, answer: { type: String, trim: true, maxlength: 500, default: "" } }],
      default: [],
    },
    history: [
      {
        _id: false,
        status: { type: String, enum: applicationStatuses, required: true },
        at: { type: Date, default: Date.now },
        note: { type: String, maxlength: 200, default: "" },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        ret.opportunity = String(ret.opportunity);
        ret.business = String(ret.business);
        ret.owner = String(ret.owner);
        ret.documents = (ret.documents ?? []).map(String);
        ret.answers = (ret.answers ?? []).map((a) => ({ questionId: String(a.question), question: a.text, answer: a.answer }));
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One application per business per opportunity.
applicationSchema.index({ opportunity: 1, business: 1 }, { unique: true });
applicationSchema.index({ owner: 1, updatedAt: -1 });
applicationSchema.index({ status: 1, submittedAt: -1 });

export const Application = mongoose.models.Application ?? mongoose.model("Application", applicationSchema);
