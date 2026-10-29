import mongoose from "mongoose";
import { Device } from "../models/Device.js";
import { User } from "../models/User.js";

/**
 * Push notifications to the phone app, through Expo's push service (https://docs.expo.dev/push-notifications/overview/).
 * The app registers its Expo push token with POST /api/devices. Expo then delivers to Apple and Google, so the server
 * needs no certificates. An optional EXPO_ACCESS_TOKEN adds Expo's enhanced security.
 *
 * What is pushed is the same short headline an email carries: never a staff note or a profile detail. Sending never
 * throws and never blocks the action that caused it. A token that Expo says no longer exists is deleted.
 */

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const BATCH = 100;

export function createPushSender(cfg, { fetchImpl = fetch, log = console } = {}) {
  const enabled = cfg?.enabled !== false;
  return {
    enabled,
    /** Sends [{ to, title, body, data }]. Returns { sent, invalidTokens }. */
    async send(messages) {
      let sent = 0;
      const invalidTokens = [];
      for (let i = 0; i < messages.length; i += BATCH) {
        const chunk = messages.slice(i, i + BATCH);
        try {
          const res = await fetchImpl(EXPO_URL, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(cfg?.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}),
            },
            body: JSON.stringify(chunk.map((m) => ({ ...m, sound: "default" }))),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            log.error(`Push notifications were not sent: Expo answered ${res.status}`);
            continue;
          }
          const json = await res.json().catch(() => null);
          const tickets = Array.isArray(json?.data) ? json.data : [];
          chunk.forEach((m, j) => {
            const t = tickets[j];
            if (t?.status === "ok") sent += 1;
            else if (t?.details?.error === "DeviceNotRegistered") invalidTokens.push(m.to);
          });
        } catch (err) {
          log.error("Push notifications were not sent:", err?.name ?? "error");
        }
      }
      return { sent, invalidTokens };
    },
  };
}

// One sender for the whole process. Tests put a fake one here.
let current = createPushSender(null);

export function configurePush(config, options = {}) {
  current = createPushSender(config.push, options);
  return current;
}
export function setPushSender(sender) {
  current = sender;
}
export const push = {
  get enabled() {
    return current.enabled;
  },
  send: (messages) => current.send(messages),
};

/**
 * Pushes one headline to every phone of the given accounts, for those who have not turned push off.
 * `link` is a path on the website (the app maps it to a screen). Returns how many pushes were accepted.
 */
export async function deliverPush(userIds, { title, body = "", link = "", type = "general", notificationId = null }) {
  try {
    if (!push.enabled || userIds.length === 0) return 0;
    const ids = userIds.map(String);
    const wanting = await User.find({ _id: mongoose.trusted({ $in: ids }), pushNotifications: mongoose.trusted({ $ne: false }), active: mongoose.trusted({ $ne: false }) }).distinct("_id");
    if (wanting.length === 0) return 0;
    const devices = await Device.find({ user: mongoose.trusted({ $in: wanting }) }).select("token").lean();
    if (devices.length === 0) return 0;
    const result = await push.send(
      devices.map((d) => ({ to: d.token, title: title.slice(0, 120), body: body.slice(0, 300), data: { link, type, ...(notificationId ? { notificationId } : {}) } })),
    );
    if (result.invalidTokens.length > 0) await Device.deleteMany({ token: mongoose.trusted({ $in: result.invalidTokens }) });
    return result.sent;
  } catch (err) {
    console.error("Push delivery failed:", err?.name);
    return 0;
  }
}
