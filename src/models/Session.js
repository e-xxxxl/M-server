import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // SHA-256 of the cookie value. A database leak therefore cannot be replayed as a login.
  tokenHash: { type: String, required: true, unique: true },
  userAgent: { type: String, maxlength: 200, default: "" },
  // "web" sessions use the cookie and expire at a fixed time. "app" sessions use a Bearer token and slide.
  client: { type: String, enum: ["web", "app"], default: "web" },
  createdAt: { type: Date, default: Date.now },
  // MongoDB removes the document automatically once this time has passed.
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const Session = mongoose.models.Session ?? mongoose.model("Session", sessionSchema);
