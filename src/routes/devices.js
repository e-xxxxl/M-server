import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { devicePlatforms, Device } from "../models/Device.js";
import { requireAuth } from "../middleware/security.js";
import { oneOf } from "../schemas.js";

const MAX_DEVICES = 10;
/** An Expo push token, as the app's push library gives it. */
const expoToken = z.string().trim().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,180}\]$/, "This is not a valid Expo push token.");

const registerSchema = z.object({ token: expoToken, platform: oneOf(devicePlatforms) }).strict();
const removeSchema = z.object({ token: expoToken }).strict();

/** The phone app tells the server which phone to send push notifications to, and stops them again on sign-out. */
export function deviceRoutes({ config }) {
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

  // Stops push notifications to this phone. Call it when the person signs out of the app.
  router.delete("/", async (req, res) => {
    const { token } = removeSchema.parse(req.body);
    await Device.deleteOne({ token, user: req.user._id });
    res.status(204).end();
  });

  return router;
}
