import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { devicePlatforms, Device } from "../models/Device.js";
import { deliverPush, push } from "../lib/push.js";
import { requireAuth } from "../middleware/security.js";
import { oneOf } from "../schemas.js";

const MAX_DEVICES = 10;
/** A Firebase Cloud Messaging device token, as the Firebase library gives it: letters, digits, colons, dashes and underscores. */
const fcmToken = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_:-]{100,4096}$/, "This is not a valid Firebase device token. Send the token that Firebase Cloud Messaging gives the app (not an Expo token).");

const registerSchema = z.object({ token: fcmToken, platform: oneOf(devicePlatforms) }).strict();
const removeSchema = z.object({ token: fcmToken }).strict();

/** The phone app tells the server which phone to send push notifications to, and stops them again on sign-out. */
export function deviceRoutes({ config, limiter }) {
  const router = Router();
  router.use(requireAuth(config));

  // Registers (or refreshes) this phone. Safe to call on every app start. A token already used by another account
  // moves to this one, because the phone now belongs to whoever is signed in on it.
  router.post("/", async (req, res) => {
    const { token, platform } = registerSchema.parse(req.body);
    const device = await Device.findOneAndUpdate({ token }, { $set: { user: req.user._id, platform, lastSeenAt: new Date() }, $setOnInsert: { token } }, { upsert: true, returnDocument: "after" });
    // An account keeps its ten most recently used phones.
    const mine = await Device.find({ user: req.user._id }).sort({ lastSeenAt: -1 }).select("_id");
    if (mine.length > MAX_DEVICES) await Device.deleteMany({ _id: mongoose.trusted({ $in: mine.slice(MAX_DEVICES).map((d) => d._id) }) });
    res.status(201).json({ device: device.toJSON() });
  });

  // Sends a test notification to this account's own phones, so the app developer can check the whole chain on a real phone.
  // It only ever goes to the person asking.
  router.post("/test", limiter, async (req, res) => {
    const devices = await Device.countDocuments({ user: req.user._id });
    const switchedOn = req.user.pushNotifications !== false;
    const sent =
      push.enabled && switchedOn && devices > 0
        ? await deliverPush([req.user._id], { title: "NMREP test notification", body: "If you can read this, push notifications work on this phone.", link: "/dashboard/", type: "test" })
        : 0;
    res.json({ pushAvailable: push.enabled, switchedOnForAccount: switchedOn, devices, sent });
  });

  // Stops push notifications to this phone. Call it when the person signs out of the app.
  router.delete("/", async (req, res) => {
    const { token } = removeSchema.parse(req.body);
    await Device.deleteOne({ token, user: req.user._id });
    res.status(204).end();
  });

  return router;
}
