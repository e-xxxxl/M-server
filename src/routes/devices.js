import { Router } from "express";
import { z } from "zod";
import { devicePlatforms, Device } from "../models/Device.js";
import { deliverPush, push } from "../lib/push.js";
import { requireAuth } from "../middleware/security.js";
import { oneOf } from "../schemas.js";
import { pushTokenSchema } from "../lib/push-token.js";
import { saveDeviceToken } from "../lib/devices.js";

const registerSchema = z.object({ token: pushTokenSchema, platform: oneOf(devicePlatforms) }).strict();
const removeSchema = z.object({ token: pushTokenSchema }).strict();

/** The phone app tells the server which phone to send push notifications to, and stops them again on sign-out. */
export function deviceRoutes({ config, limiter }) {
  const router = Router();
  router.use(requireAuth(config));

  // Registers (or refreshes) this phone. Safe to call on every app start. A token already used by another account
  // moves to this one, because the phone now belongs to whoever is signed in on it.
  router.post("/", async (req, res) => {
    const { token, platform } = registerSchema.parse(req.body);
    // Tied to this sign-in: when the sign-in ends, delivery to the phone stops. An account keeps its ten most recent phones.
    const device = await saveDeviceToken({ userId: req.user._id, token, platform, sessionId: req.session?._id ?? null });
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
