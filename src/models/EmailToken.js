import mongoose from "mongoose";

/**
 * A one-time link sent by email: confirm an email address, or reset a password.
 * Only a SHA-256 hash of the token is stored, so a database leak cannot be used to take over an account.
 * MongoDB deletes the record once it expires.
 */
const emailTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["verify", "reset"], required: true },
  tokenHash: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const EmailToken = mongoose.models.EmailToken ?? mongoose.model("EmailToken", emailTokenSchema);
