import mongoose from "mongoose";

/**
 * The documents an owner has chosen to show NMREP's reviewers for verification (the "document check" step of the
 * framework's verification flow). One record per business. The owner can change or remove the choice at any time;
 * removing it ends the sharing. Only the ids are kept: the files stay in the owner's wallet.
 */
const submissionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    documents: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const VerificationSubmission = mongoose.models.VerificationSubmission ?? mongoose.model("VerificationSubmission", submissionSchema);
