import mongoose from "mongoose";
import { criterionKeys } from "../lib/eligibility.js";
import { criterionLevels, opportunityStatuses, opportunityTypes, trainingModes } from "../lib/opportunity-constants.js";

const criterionSchema = new mongoose.Schema(
  {
    key: { type: String, enum: criterionKeys, required: true },
    level: { type: String, enum: criterionLevels, required: true },
    values: { type: [String], default: undefined },
    min: { type: Number },
    max: { type: Number },
  },
  { _id: false },
);

// Each session has its own id (a real _id), because attendance is recorded against it.
const sessionSchema = new mongoose.Schema({ title: { type: String, required: true, trim: true, maxlength: 100 }, on: { type: Date, required: true } });

/** The plan of a training: how it is delivered, when, its sessions and what completing it takes. Only used when type is Training. */
const trainingSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: trainingModes, default: "In person" },
    venue: { type: String, trim: true, maxlength: 200, default: "" },
    startsOn: { type: Date, default: null },
    endsOn: { type: Date, default: null },
    sessions: { type: [sessionSchema], default: [] },
    // To complete, a participant must have attended at least this many sessions, and (if set) passed the assessment.
    minSessions: { type: Number, default: 0, min: 0 },
    requirePass: { type: Boolean, default: false },
  },
  { _id: false },
);

const opportunitySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    provider: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: opportunityTypes, required: true },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    // End of the last day applications are accepted. Null means no deadline.
    deadline: { type: Date, default: null },
    status: { type: String, enum: opportunityStatuses, default: "Draft" },
    // The partner organisation that owns it. Null means NMREP runs it.
    organisation: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
    // The first day applications are accepted. Null means as soon as it is open.
    opensOn: { type: Date, default: null },
    // How many applications can be approved. Null means no limit.
    beneficiaryLimit: { type: Number, default: null, min: 1 },
    // The reason an opportunity was sent back to its partner.
    reviewNote: { type: String, maxlength: 200, default: "" },
    criteria: { type: [criterionSchema], default: [] },
    // Only for type Training. Null until the provider fills in the plan.
    training: { type: trainingSchema, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    openedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        ret.createdBy = String(ret.createdBy);
        ret.organisation = ret.organisation ? String(ret.organisation) : null;
        if (ret.training) ret.training.sessions = (ret.training.sessions ?? []).map((s) => ({ id: String(s._id), title: s.title, on: s.on }));
        else ret.training = null;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

opportunitySchema.index({ status: 1, deadline: 1 });
opportunitySchema.index({ organisation: 1, status: 1 });

/** Open means published, already started and not past its deadline. */
opportunitySchema.methods.isAcceptingApplications = function (now = new Date()) {
  return this.status === "Open" && (!this.opensOn || this.opensOn <= now) && (!this.deadline || this.deadline >= now);
};

export const Opportunity = mongoose.models.Opportunity ?? mongoose.model("Opportunity", opportunitySchema);
