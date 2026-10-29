import mongoose from "mongoose";

/** A message an administrator sent to a group of business owners. The messages themselves are notifications. */
const broadcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 300, default: "" },
    link: { type: String, default: "", maxlength: 120 },
    // Who it went to. An empty list means "any".
    audience: {
      states: { type: [String], default: [] },
      sectors: { type: [String], default: [] },
      verificationStatuses: { type: [String], default: [] },
    },
    recipients: { type: Number, required: true },
    // Also emailed? And what delivery reached, written back when it finishes (it runs in the background).
    sendEmail: { type: Boolean, default: true },
    emailsQueued: { type: Number, default: 0 },
    pushesSent: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
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

export const Broadcast = mongoose.models.Broadcast ?? mongoose.model("Broadcast", broadcastSchema);
