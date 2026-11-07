import mongoose from "mongoose";
import { Device } from "../models/Device.js";
import { isPushToken } from "./push-token.js";

/** An account keeps its ten most recently used phones. */
export const MAX_DEVICES = 10;

/**
 * Remembers a phone's push token for an account. A token belongs to one account at a time (the phone now belongs to
 * whoever is signed in on it). With a `sessionId` the token is tied to that sign-in, so signing out stops delivery to it.
 * `replace` makes the token the only one of that sign-in (the app's "save or replace my token").
 */
export async function saveDeviceToken({ userId, token, platform = "", sessionId = null, replace = false }) {
  const set = { user: userId, lastSeenAt: new Date(), session: sessionId };
  if (platform) set.platform = platform;
  const device = await Device.findOneAndUpdate({ token }, { $set: set, $setOnInsert: { token, ...(platform ? {} : { platform: "unknown" }) } }, { upsert: true, returnDocument: "after" });
  if (replace && sessionId) await Device.deleteMany({ user: userId, session: sessionId, token: mongoose.trusted({ $ne: token }) });
  const mine = await Device.find({ user: userId }).sort({ lastSeenAt: -1 }).select("_id");
  if (mine.length > MAX_DEVICES) await Device.deleteMany({ _id: mongoose.trusted({ $in: mine.slice(MAX_DEVICES).map((d) => d._id) }) });
  return device;
}

/** The token given at sign-in or sign-up. Empty or missing is fine and does nothing. Returns true when a token was saved. */
export async function saveLoginToken(userId, sessionId, raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token || !isPushToken(token)) return false;
  await saveDeviceToken({ userId, token, sessionId });
  return true;
}

/** Stops delivery to the phones of one sign-in. */
export const removeSessionDevices = (sessionId) => Device.deleteMany({ session: sessionId });

/** Stops delivery to every phone of an account. */
export const removeUserDevices = (userId) => Device.deleteMany({ user: userId });
