import mongoose from "mongoose";

/**
 * A record of what admins did. Entries hold who, what and which record, never passwords,
 * session tokens or the contents of a profile.
 */
const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // Kept as text so the entry still reads correctly if the account is later changed.
  actorName: { type: String, required: true, maxlength: 120 },
  action: { type: String, required: true, maxlength: 60 },
  targetType: { type: String, maxlength: 30, default: "" },
  targetId: { type: String, maxlength: 40, default: "" },
  summary: { type: String, required: true, maxlength: 300 },
  at: { type: Date, default: Date.now, index: true },
});

export const AuditLog = mongoose.models.AuditLog ?? mongoose.model("AuditLog", auditSchema);

/** Records an admin action. A failure to log must never break the action itself. */
export async function audit(actor, action, summary, target = {}) {
  try {
    await AuditLog.create({
      actor: actor._id,
      actorName: `${actor.fullName} (${actor.role === "super_admin" ? "super admin" : actor.role === "partner" ? "partner" : "admin"})`,
      action,
      summary,
      targetType: target.type ?? "",
      targetId: target.id ? String(target.id) : "",
    });
  } catch (err) {
    console.error("Audit log write failed:", err?.name);
  }
}
