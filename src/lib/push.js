import crypto from "node:crypto";
import fs from "node:fs";
import mongoose from "mongoose";
import { Device } from "../models/Device.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { isExpoToken } from "./push-token.js";

/**
 * Push notifications to the phone app. Two kinds of token are delivered, chosen by the shape of the token:
 * - an Expo push token (`ExponentPushToken[...]`) goes through Expo's push service, which needs no key here (an optional
 *   EXPO_ACCESS_TOKEN adds Expo's enhanced security);
 * - a raw Firebase device token goes through Firebase Cloud Messaging (the HTTP v1 API) with the server's own key.
 * Either way the app registers its token at sign-in (devicePushToken), with POST /api/account/push-token or with
 * POST /api/devices, and the token is tied to that sign-in: signing out stops delivery to it.
 *
 * - For Firebase the server signs in with a SERVICE ACCOUNT key (a JSON file from the Firebase console). The key lives
 *   only on the server, is read once at start, is never logged, never returned and never stored in the database. The
 *   short lived access token made from it is kept in memory only.
 * - What is pushed is the same short headline an email carries: never a staff note or a profile detail.
 * - Sending never throws and never blocks the action that caused it. A token that Firebase says no longer exists is deleted.
 * - Without a Firebase key only Expo tokens are delivered; everything else works.
 * - Every alert uses the Android notification channel "alerts" (the app creates it) and carries data.link, the app screen to open.
 */

/** The Android notification channel every alert uses. The app creates a channel with this id. */
export const ALERT_CHANNEL = "alerts";
/** The app screen every alert opens: the inbox. */
export const APP_INBOX = "/notifications";
const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH = 100;

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const sendUrl = (projectId) => `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
/** FCM v1 takes one message per request, so they are sent a few at a time. */
const CONCURRENCY = 20;
const TIMEOUT_MS = 15_000;

const b64url = (input) => Buffer.from(input).toString("base64url");

/**
 * Reads the service account from a file (FIREBASE_SERVICE_ACCOUNT_FILE) or from base64 text (FIREBASE_SERVICE_ACCOUNT_BASE64).
 * Returns { clientEmail, privateKey, projectId, tokenUri } or null. A problem is reported by reason only, never with content.
 */
export function loadFirebaseCredentials(cfg, { log = console } = {}) {
  const file = cfg?.serviceAccountFile ?? "";
  const encoded = cfg?.serviceAccountBase64 ?? "";
  if (!file && !encoded) return null;
  let parsed;
  try {
    const text = file ? fs.readFileSync(file, "utf8") : Buffer.from(encoded, "base64").toString("utf8");
    parsed = JSON.parse(text);
  } catch (err) {
    log.error(`Firebase service account could not be read (${file ? "file" : "base64"}): ${err?.code ?? err?.name ?? "error"}.`);
    return null;
  }
  const projectId = String(cfg.projectId || parsed.project_id || "");
  const tokenUri = String(parsed.token_uri || DEFAULT_TOKEN_URI);
  const ok =
    typeof parsed.client_email === "string" &&
    typeof parsed.private_key === "string" &&
    parsed.private_key.includes("PRIVATE KEY") &&
    /^[a-z][a-z0-9-]{4,60}$/.test(projectId) &&
    tokenUri.startsWith("https://");
  if (!ok) {
    log.error("Firebase service account is not valid: it needs client_email, private_key and a project id. Download a new key from the Firebase console.");
    return null;
  }
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key, projectId, tokenUri };
}

function createFcmSender(cfg, { fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
  const credentials = cfg.credentials;
  let cached = null; // { value, expiresAt }

  /** A short lived Google access token for this server, made from the service account. Null when Google refuses. */
  async function accessToken(force = false) {
    if (!force && cached && cached.expiresAt - 60_000 > now()) return cached.value;
    try {
      const iat = Math.floor(now() / 1000);
      const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
        JSON.stringify({ iss: credentials.clientEmail, scope: SCOPE, aud: credentials.tokenUri, iat, exp: iat + 3600 }),
      )}`;
      const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), credentials.privateKey).toString("base64url");
      const res = await fetchImpl(credentials.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.access_token) {
        log.error(`Firebase did not give an access token: HTTP ${res.status}. Check the service account key.`);
        return null;
      }
      cached = { value: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
      return cached.value;
    } catch (err) {
      log.error("Firebase sign-in failed:", err?.name ?? "error");
      return null;
    }
  }

  /** One message. Returns { sent, invalid, fatal }. Nothing from the message is ever logged. */
  async function sendOne(m, retried = false) {
    const token = await accessToken(retried);
    if (!token) return { sent: 0, fatal: true };
    const data = Object.fromEntries(Object.entries(m.data ?? {}).map(([k, v]) => [k, String(v)]));
    const message = {
      token: m.to,
      notification: { title: m.title, ...(m.body ? { body: m.body } : {}) },
      data,
      android: { priority: "HIGH", notification: { sound: "default", channel_id: ALERT_CHANNEL } },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
    };
    let res;
    try {
      res = await fetchImpl(sendUrl(credentials.projectId), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      log.error("Push notification was not sent:", err?.name ?? "error");
      return { sent: 0 };
    }
    if (res.ok) return { sent: 1 };

    const json = await res.json().catch(() => null);
    const status = json?.error?.status ?? "";
    const code = (json?.error?.details ?? []).map((d) => d?.errorCode).find(Boolean) ?? "";
    // The access token expired or was revoked: get a new one and try this message once more.
    if (res.status === 401 && !retried) {
      cached = null;
      return sendOne(m, true);
    }
    // The token is not (or no longer) a working phone: forget it.
    if (res.status === 404 || code === "UNREGISTERED" || status === "NOT_FOUND" || code === "SENDER_ID_MISMATCH") return { sent: 0, invalid: true };
    if (res.status === 400 && status === "INVALID_ARGUMENT" && /token/i.test(json?.error?.message ?? "")) return { sent: 0, invalid: true };
    if (res.status === 401 || res.status === 403) {
      log.error(`Firebase refused the request: HTTP ${res.status}. Check the service account, its Firebase Cloud Messaging permission and that the Firebase Cloud Messaging API is enabled.`);
      return { sent: 0, fatal: true };
    }
    log.error(`Push notification was not sent: Firebase answered ${res.status}${status ? ` ${status}` : ""}.`);
    return { sent: 0 };
  }

  return {
    /** Sends [{ to, title, body, data }]. Returns { sent, invalidTokens }. */
    async send(messages) {
      let sent = 0;
      const invalidTokens = [];
      let stopped = false;
      for (let i = 0; i < messages.length && !stopped; i += CONCURRENCY) {
        const results = await Promise.all(messages.slice(i, i + CONCURRENCY).map((m) => sendOne(m)));
        results.forEach((r, j) => {
          sent += r.sent;
          if (r.invalid) invalidTokens.push(messages[i + j].to);
          if (r.fatal) stopped = true; // a problem with our own credentials: no point trying the rest
        });
      }
      return { sent, invalidTokens };
    },
  };
}

function createExpoSender(cfg, { fetchImpl = fetch, log = console } = {}) {
  return {
    /** Sends [{ to, title, body, data }] to Expo's push service. Returns { sent, invalidTokens }. */
    async send(messages) {
      let sent = 0;
      const invalidTokens = [];
      for (let i = 0; i < messages.length; i += EXPO_BATCH) {
        const chunk = messages.slice(i, i + EXPO_BATCH);
        try {
          const res = await fetchImpl(EXPO_URL, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", ...(cfg?.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}) },
            body: JSON.stringify(chunk.map((m) => ({ to: m.to, title: m.title, ...(m.body ? { body: m.body } : {}), data: m.data ?? {}, sound: "default", priority: "high", channelId: ALERT_CHANNEL }))),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) {
            log.error(`Push notifications were not sent: Expo answered ${res.status}`);
            continue;
          }
          const json = await res.json().catch(() => null);
          const tickets = Array.isArray(json?.data) ? json.data : [];
          chunk.forEach((m, j) => {
            const ticket = tickets[j];
            if (ticket?.status === "ok") sent += 1;
            else if (ticket?.details?.error === "DeviceNotRegistered") invalidTokens.push(m.to);
          });
        } catch (err) {
          log.error("Push notifications were not sent:", err?.name ?? "error");
        }
      }
      return { sent, invalidTokens };
    },
  };
}

/**
 * The sender for the whole app: Expo tokens go to Expo, Firebase tokens go to Firebase. `cfg` is
 * { enabled, credentials, expo: { accessToken } }; `null` means push is not set up (tests, and before the server starts).
 */
export function createPushSender(cfg, options = {}) {
  if (!cfg) return { enabled: false, firebase: false, async send() { return { sent: 0, invalidTokens: [] }; } };
  const log = options.log ?? console;
  const expo = createExpoSender(cfg.expo, options);
  const fcm = cfg.credentials ? createFcmSender({ credentials: cfg.credentials }, options) : null;
  let warned = false;
  return {
    enabled: cfg.enabled !== false,
    firebase: Boolean(fcm),
    async send(messages) {
      const viaExpo = messages.filter((m) => isExpoToken(m.to));
      const viaFcm = messages.filter((m) => !isExpoToken(m.to));
      const parts = [];
      if (viaExpo.length > 0) parts.push(await expo.send(viaExpo));
      if (viaFcm.length > 0) {
        if (fcm) parts.push(await fcm.send(viaFcm));
        else if (!warned) {
          warned = true;
          log.error("Push to a Firebase device token was skipped: the server has no Firebase service account key (FIREBASE_SERVICE_ACCOUNT_FILE).");
        }
      }
      return { sent: parts.reduce((n, p) => n + p.sent, 0), invalidTokens: parts.flatMap((p) => p.invalidTokens) };
    },
  };
}

// One sender for the whole process. Tests put a fake one here.
let current = createPushSender(null);

/** Called once by the server: reads the Firebase key and starts the sender. */
export function configurePush(config, options = {}) {
  const credentials = config.push.enabled === false ? null : loadFirebaseCredentials(config.push.firebase, options);
  current = createPushSender({ enabled: config.push.enabled, credentials, expo: config.push.expo }, options);
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
    const all = await Device.find({ user: mongoose.trusted({ $in: wanting }) }).select("token session").lean();
    // A token tied to a sign-in is only used while that sign-in is alive. Tokens of ended sign-ins are forgotten here too,
    // however the sign-in ended (sign out, password change, expiry, an administrator).
    const linked = [...new Set(all.filter((d) => d.session).map((d) => String(d.session)))];
    const alive = new Set(linked.length ? (await Session.find({ _id: mongoose.trusted({ $in: linked }), expiresAt: mongoose.trusted({ $gt: new Date() }) }).select("_id").lean()).map((s) => String(s._id)) : []);
    const gone = all.filter((d) => d.session && !alive.has(String(d.session)));
    if (gone.length > 0) await Device.deleteMany({ _id: mongoose.trusted({ $in: gone.map((d) => d._id) }) });
    const devices = all.filter((d) => !d.session || alive.has(String(d.session)));
    if (devices.length === 0) return 0;
    // data.link is the app screen to open (every alert is also a row in the inbox, GET /api/notifications). webLink is the
    // matching page on the website, for an app that wants to open something more specific.
    const data = { link: APP_INBOX, ...(link ? { webLink: link } : {}), type, ...(notificationId ? { notificationId } : {}) };
    const result = await push.send(devices.map((d) => ({ to: d.token, title: title.slice(0, 120), body: body.slice(0, 300), data })));
    if (result.invalidTokens.length > 0) await Device.deleteMany({ token: mongoose.trusted({ $in: result.invalidTokens }) });
    return result.sent;
  } catch (err) {
    console.error("Push delivery failed:", err?.name);
    return 0;
  }
}
