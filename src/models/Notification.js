import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true, maxlength: 30 },
  title: { type: String, required: true, maxlength: 120 },
  body: { type: String, default: "", maxlength: 300 },
  // A path inside the dashboard, for example /dashboard/applications/. Never an outside address.
  link: { type: String, default: "", maxlength: 120 },
  readAt: { type: Date, default: null },
  // Set when it was sent as part of an administrator's broadcast.
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: "Broadcast", default: undefined, index: true },
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.user;
    delete ret.broadcast;
    return ret;
  },
});

export const Notification = mongoose.models.Notification ?? mongoose.model("Notification", notificationSchema);

/** The kinds of notification that are also sent by email. New opportunity announcements stay in the app (and the phone) only. */
const EMAILED = new Set(["application", "verification", "opportunity", "announcement"]);
/** The kinds whose text may travel in an email or a push: written by an administrator or about a programme, never a staff note. */
const SHOWS_TEXT = new Set(["opportunity", "announcement", "payment"]);

/**
 * Tells a user something: in the app, on their phone (push) and, for the kinds above and when email is set up, by
 * email. Owners can turn email and push off. `bulk` is for a message that goes to many people: its email goes through
 * the batch queue. A failure here must never break the action that caused it.
 */
export async function notify(userId, { type, title, body = "", link = "" }, { bulk = false } = {}) {
  let created;
  try {
    created = await Notification.create({ user: userId, type, title, body, link });
  } catch (err) {
    console.error("Notification write failed:", err?.name);
    return;
  }
  try {
    // Imported here so the user, push and email code is only loaded when it is needed.
    const [{ deliverPush }, { sendNotificationEmail }] = await Promise.all([import("../lib/push.js"), import("../lib/account-emails.js")]);
    const text = SHOWS_TEXT.has(type) ? body : "";
    await deliverPush([userId], { title, body: text, link, type, notificationId: String(created._id) });
    if (EMAILED.has(type)) await sendNotificationEmail(userId, { title, body: text, link, bulk });
  } catch (err) {
    console.error("Notification delivery failed:", err?.name);
  }
}
