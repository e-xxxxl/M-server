import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { ApiError } from "../middleware/errors.js";
import { notify } from "../models/Notification.js";
import { Business } from "../models/Business.js";
import { PlaySubscription } from "../models/PlaySubscription.js";
import { User } from "../models/User.js";
import { createTokenSource, loadServiceAccount } from "./google-service-account.js";
import { alertPlaySubscribed } from "./staff-alerts.js";
import { restoreAfterRenewal } from "./subscription.js";

/**
 * Subscriptions bought in the mobile app through Google Play.
 *
 * The app sends the purchase token after a purchase (POST /api/payments/play/verify). The server never believes the app:
 * it asks Google (Google Play Developer API, subscriptionsv2) what the purchase is, and only then gives the account its
 * time. A Play purchase gives the same thing a website payment does: `registrationPaidUntil` moves forward, so the one
 * paywall, the suspension on expiry and the admin screens all work the same for both. Google's real-time notifications
 * (and a periodic check of lapsed ones) keep renewals, cancellations and refunds in step.
 */

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const TIMEOUT_MS = 15_000;
const DAY = 24 * 60 * 60 * 1000;
/** A payment that failed to renew keeps access for a short while (Google's grace period) until Google says what happened. */
const GRACE_MS = 3 * DAY;

const ENTITLED_STATES = new Set(["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_CANCELED", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"]);

// ------------------------------------------------------------------ the client

/** The Google Play client. `cfg` is config.googlePlay. Without a usable service account it is off. */
export function createPlayClient(cfg, { fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
  const credentials = loadServiceAccount({ json: cfg?.serviceAccountJson, file: cfg?.serviceAccountFile, base64: cfg?.serviceAccountBase64 }, { log, label: "Google Play service account" });
  const accessToken = credentials ? createTokenSource(credentials, SCOPE, { fetchImpl, log, now }) : null;

  async function call(method, url, body, retried = false) {
    const token = await accessToken(retried);
    if (!token) return { unavailable: true };
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      log.error("Google Play request failed:", err?.name ?? "error");
      return { unavailable: true };
    }
    if (res.status === 401 && !retried) return call(method, url, body, true);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  return {
    enabled: Boolean(credentials),

    /** What Google says about a purchase token: { found, state, productId, basePlanId, expiresAt, autoRenewing, acknowledged, orderId } or { unavailable }. */
    async getSubscription(packageName, purchaseToken) {
      const r = await call("GET", `${API}/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
      if (r.unavailable) return { unavailable: true };
      // A token Google does not know (wrong, made up, or for another app) is not an outage: it is simply not a purchase.
      if ([400, 404, 410].includes(r.status)) return { found: false };
      if (r.status !== 200 || !r.json) {
        log.error(`Google Play answered HTTP ${r.status} for a purchase check. Check the service account's access in the Play Console.`);
        return { unavailable: true };
      }
      const d = r.json;
      const line = (d.lineItems ?? []).find((l) => l?.productId) ?? {};
      return {
        found: true,
        state: String(d.subscriptionState ?? ""),
        productId: String(line.productId ?? ""),
        basePlanId: String(line.offerDetails?.basePlanId ?? ""),
        expiresAt: line.expiryTime ? new Date(line.expiryTime) : null,
        autoRenewing: Boolean(line.autoRenewingPlan?.autoRenewEnabled),
        acknowledged: d.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        orderId: String(d.latestOrderId ?? ""),
      };
    },

    /** A subscription must be acknowledged within three days or Google refunds it. The app usually does it; this is the safety net. */
    async acknowledge(packageName, productId, purchaseToken) {
      const r = await call("POST", `${API}/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
      return !r.unavailable && (r.status === 200 || r.status === 204);
    },
  };
}

// One client for the whole process, set up once at start. Until then (and in tests) it is off.
let current = null;
export const play = {
  get enabled() {
    return Boolean(current?.enabled);
  },
  getSubscription: (...a) => (current ? current.getSubscription(...a) : { unavailable: true }),
  acknowledge: (...a) => (current ? current.acknowledge(...a) : false),
};
export const setPlay = (client) => {
  current = client ?? null;
};
export function configurePlay(config, options) {
  const client = createPlayClient(config.googlePlay, options);
  setPlay(client);
  return client;
}

// ------------------------------------------------------------------ what an account is entitled to

/** Whether a Google answer gives access, and until when. */
export function entitlementOf(result, now = new Date()) {
  if (!result?.found || !ENTITLED_STATES.has(result.state) || !result.expiresAt || Number.isNaN(result.expiresAt.getTime())) return { active: false, until: null };
  if (result.state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") return { active: true, until: new Date(Math.max(result.expiresAt.getTime(), now.getTime() + GRACE_MS)) };
  if (result.expiresAt <= now) return { active: false, until: null };
  return { active: true, until: result.expiresAt };
}

/**
 * The subscription as the app reads it, from the account: `active` unlocks the paid features. When the fee is not being
 * charged (development) every account is active. `source` is where the current paid time came from.
 */
export function subscriptionView(user, config, now = new Date()) {
  const until = user.registrationPaidUntil ?? null;
  const paid = Boolean(until && until > now);
  const source = paid ? user.subscriptionSource || "web" : null;
  return {
    active: !config.payments.enabled || paid,
    source,
    productId: source === "google_play" ? user.subscriptionProductId || config.googlePlay.productId : null,
    expiresAt: paid ? until : null,
    autoRenewing: source === "google_play" ? Boolean(user.subscriptionAutoRenewing) : source === "web" ? false : null,
  };
}

/** Gives the account the time a confirmed purchase pays for. Never shortens time that was paid another way. */
async function grant(user, record, until, autoRenewing, config) {
  const was = user.registrationPaidUntil && user.registrationPaidUntil > new Date() ? user.registrationPaidUntil : null;
  if (!was || until >= was) {
    user.registrationPaidUntil = until;
    user.subscriptionSource = "google_play";
    user.subscriptionProductId = record.productId;
    user.subscriptionAutoRenewing = autoRenewing;
    await user.save();
  }
  await restoreAfterRenewal(user._id);
  void config;
}

/** The purchase no longer gives access (refunded, expired, on hold). Ends the paid time only if it came from Google Play. */
async function revoke(user) {
  if (user.subscriptionSource === "google_play" && user.registrationPaidUntil && user.registrationPaidUntil > new Date()) {
    user.registrationPaidUntil = new Date();
    user.subscriptionAutoRenewing = false;
    await user.save();
  } else if (user.subscriptionSource === "google_play" && user.subscriptionAutoRenewing) {
    user.subscriptionAutoRenewing = false;
    await user.save();
  }
}

/** Applies what Google said to the stored purchase and the account. Returns the entitlement. */
async function apply(config, record, result, { announce = false } = {}) {
  const e = entitlementOf(result);
  const wasEntitled = record.entitled;
  record.state = result.state;
  record.productId = result.productId || record.productId;
  record.basePlanId = result.basePlanId || record.basePlanId;
  record.orderId = result.orderId || record.orderId;
  record.expiresAt = result.expiresAt ?? record.expiresAt;
  record.autoRenewing = result.autoRenewing;
  record.entitled = e.active;
  record.lastCheckedAt = new Date();
  await record.save();

  const user = await User.findById(record.user);
  if (!user) return e;
  if (e.active) {
    await grant(user, record, e.until, result.autoRenewing, config);
    if (announce && !wasEntitled) {
      await notify(user._id, {
        type: "payment",
        title: "Subscription active",
        body: `Thank you. Your NMREP subscription through Google Play is active until ${e.until.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" })}.`,
        link: "/dashboard/",
      });
      alertPlaySubscribed(config, { business: await Business.findOne({ owner: user._id }).select("businessName"), user, expiresAt: e.until });
    }
  } else if (wasEntitled) {
    await revoke(user);
  }
  return e;
}

// ------------------------------------------------------------------ the endpoints' work

/** POST /api/payments/play/verify. Returns the account's subscription (the same object as on /api/auth/me). */
export async function verifyPlayPurchase(config, user, { productId, purchaseToken, packageName }) {
  const cfg = config.googlePlay;
  if (!play.enabled) throw new ApiError(503, "play_unavailable", "Google Play purchases cannot be confirmed right now. Please try again later.");
  const invalid = () => new ApiError(422, "invalid_purchase", "This purchase could not be confirmed.");
  if (packageName !== cfg.packageName || productId !== cfg.productId) throw invalid();

  const existing = await PlaySubscription.findOne({ purchaseToken });
  if (existing && String(existing.user) !== String(user._id)) {
    throw new ApiError(409, "purchase_in_use", "This purchase already belongs to another account.");
  }

  const result = await play.getSubscription(cfg.packageName, purchaseToken);
  if (result.unavailable) throw new ApiError(503, "play_unavailable", "Google Play purchases cannot be confirmed right now. Please try again later.");
  if (!result.found || result.productId !== cfg.productId) throw invalid();

  let record = existing;
  if (!record) {
    try {
      record = await PlaySubscription.create({ purchaseToken, user: user._id, packageName: cfg.packageName, productId: cfg.productId, basePlanId: result.basePlanId });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      record = await PlaySubscription.findOne({ purchaseToken });
      if (!record || String(record.user) !== String(user._id)) throw new ApiError(409, "purchase_in_use", "This purchase already belongs to another account.");
    }
  }

  const e = await apply(config, record, result, { announce: true });
  if (!e.active) {
    const pending = result.state === "SUBSCRIPTION_STATE_PENDING";
    throw new ApiError(422, pending ? "subscription_pending" : "subscription_inactive", pending ? "This purchase is still pending. It will unlock when Google Play confirms the payment." : "This subscription is not active.");
  }
  if (!result.acknowledged) void play.acknowledge(cfg.packageName, cfg.productId, purchaseToken).catch(() => null);

  const fresh = await User.findById(user._id);
  return subscriptionView(fresh, config);
}

/** Asks Google again about a stored purchase and applies the answer. Returns "unknown", "unavailable" or "ok". */
export async function syncPurchase(config, purchaseToken) {
  const record = await PlaySubscription.findOne({ purchaseToken });
  if (!record) return "unknown";
  const result = await play.getSubscription(config.googlePlay.packageName, purchaseToken);
  if (result.unavailable) return "unavailable";
  // Google no longer knows the token: treat it as ended.
  await apply(config, record, result.found ? result : { found: false, state: "SUBSCRIPTION_STATE_EXPIRED", expiresAt: null, autoRenewing: false });
  return "ok";
}

/**
 * Renewals the server has not heard about (a missed notification): purchases that were giving access and whose time has
 * passed are asked about again, so a renewed one is extended and an ended one lapses. Runs with the maintenance job.
 */
export async function refreshLapsedPlaySubscriptions(config, now = new Date(), { limit = 50 } = {}) {
  if (!play.enabled) return 0;
  const due = await PlaySubscription.find({ entitled: true, expiresAt: mongoose.trusted({ $lte: new Date(now.getTime() + DAY) }) }).limit(limit);
  let n = 0;
  for (const record of due) {
    if ((await syncPurchase(config, record.purchaseToken)) === "ok") n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ Google's real-time notifications

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Google Play real-time developer notifications arrive here through a Pub/Sub push subscription. Nothing in the message is
 * believed: it only names a purchase token, and the purchase is then asked about with Google. So a forged message can only
 * cause a re-check. If GOOGLE_PLAY_RTDN_SECRET is set, the push address must carry it as ?secret=. Answers 200 when handled
 * (so Pub/Sub stops retrying) and 503 when Google could not be reached (so it tries again).
 */
export function playWebhook({ config }) {
  return [
    express.json({ limit: "50kb", strict: false }),
    async (req, res) => {
      const secret = config.googlePlay.rtdnSecret;
      if (secret && !safeEqual(req.query.secret, secret)) throw new ApiError(401, "invalid_secret", "Invalid secret.");
      let note = null;
      try {
        note = JSON.parse(Buffer.from(String(req.body?.message?.data ?? ""), "base64").toString("utf8"));
      } catch {
        note = null;
      }
      const token = note?.packageName === config.googlePlay.packageName ? note?.subscriptionNotification?.purchaseToken : null;
      if (typeof token === "string" && token.length > 0 && token.length <= 2000) {
        const outcome = await syncPurchase(config, token);
        if (outcome === "unavailable") throw new ApiError(503, "play_unavailable", "Try again later.");
      }
      res.json({ received: true });
    },
  ];
}
