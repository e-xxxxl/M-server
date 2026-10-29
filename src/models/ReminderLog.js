import mongoose from "mongoose";

/**
 * One row per reminder already sent, so the reminder job can run any number of times (or on two servers) without
 * telling the same person the same thing twice. The unique index is the guarantee.
 */
const reminderSchema = new mongoose.Schema(
  {
    opportunity: { type: mongoose.Schema.Types.ObjectId, ref: "Opportunity", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // "deadline-3d", "deadline-1d" or "session:<session id>".
    kind: { type: String, required: true, maxlength: 60 },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

reminderSchema.index({ opportunity: 1, owner: 1, kind: 1 }, { unique: true });

export const ReminderLog = mongoose.models.ReminderLog ?? mongoose.model("ReminderLog", reminderSchema);
