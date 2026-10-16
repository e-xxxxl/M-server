import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true, maxlength: 30 },
  title: { type: String, required: true, maxlength: 120 },
  body: { type: String, default: "", maxlength: 300 },
  // A path inside the dashboard, for example /dashboard/applications/. Never an outside address.
  link: { type: String, default: "", maxlength: 120 },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.user;
    return ret;
  },
});

export const Notification = mongoose.models.Notification ?? mongoose.model("Notification", notificationSchema);

/** The kinds of notification that are also sent by email. New opportunity announcements stay in the app only. */
const EMAILED = new Set(["application", "verification"]);

/**
 * Tells a user something, in the app and (for important changes, when email is set up) by email.
 * A failure here must never break the action that caused it.
 */
export async function notify(userId, { type, title, body = "", link = "" }) {
  try {
    await Notification.create({ user: userId, type, title, body, link });
  } catch (err) {
    console.error("Notification write failed:", err?.name);
    return;
  }
  if (!EMAILED.has(type)) return;
  try {
    // Imported here so the user and email code is only loaded when it is needed.
    const [{ emailSettings, mailer }, { User }, { sendUpdate }] = await Promise.all([
      import("../lib/mailer.js"),
      import("./User.js"),
      import("../lib/account-emails.js"),
    ]);
    if (!mailer.enabled || !emailSettings().notifications) return;
    const user = await User.findById(userId).select("email fullName role active");
    // The email carries the headline only. Staff notes and profile details stay behind the login.
    if (user && user.active !== false && user.role === "msme_owner") sendUpdate(user, title);
  } catch (err) {
    console.error("Notification email failed:", err?.name);
  }
}
