import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPlayClient, entitlementOf, refreshLapsedPlaySubscriptions, setPlay, subscriptionView } from "../src/lib/play-billing.js";
import { runSubscriptionReminders } from "../src/lib/subscription.js";
import { Notification } from "../src/models/Notification.js";
import { PlaySubscription } from "../src/models/PlaySubscription.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Subscriptions bought in the app through Google Play. Google is replaced by a fake that answers from a table.

let ctx;
let call;
const DAY = 24 * 60 * 60 * 1000;
const PKG = "com.onlinebizproj.nmrepmbl";
const PRODUCT = "nmrep_annual";
const SECRET = "rtdn-secret-for-tests";

const answers = new Map(); // purchaseToken -> what Google says
const asked = [];
let acked = [];
let outage = false;
const fakeGoogle = {
  enabled: true,
  async getSubscription(packageName, token) {
    asked.push({ packageName, token });
    if (outage) return { unavailable: true };
    return answers.get(token) ?? { found: false };
  },
  async acknowledge(packageName, productId, token) {
    acked.push({ packageName, productId, token });
    return true;
  },
};
const grant = (token, over = {}) =>
  answers.set(token, { found: true, state: "SUBSCRIPTION_STATE_ACTIVE", productId: PRODUCT, basePlanId: "yearly", expiresAt: new Date(Date.now() + 365 * DAY), autoRenewing: true, acknowledged: false, orderId: "GPA.1", ...over });

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", GOOGLE_PLAY_RTDN_SECRET: SECRET, RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
});
after(async () => {
  setPlay(null);
  await ctx.stop();
});
beforeEach(() => {
  setPlay(fakeGoogle);
  answers.clear();
  asked.length = 0;
  acked = [];
  outage = false;
});

async function owner() {
  const body = registrationBody();
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, res.text);
  return { cookie: res.cookie, id: res.json.user.id, email: body.account.email, registered: res.json };
}
const verify = (o, body = {}) => call("POST", "/api/payments/play/verify", { cookie: o.cookie, body: { productId: PRODUCT, packageName: PKG, basePlanId: "yearly", purchaseToken: `token-${"x".repeat(20)}`, ...body } });
const me = async (o) => (await call("GET", "/api/auth/me", { cookie: o.cookie })).json;
const notification = (token, secret = SECRET, extra = {}) =>
  call("POST", `/api/webhooks/google-play${secret === null ? "" : `?secret=${secret}`}`, {
    origin: null,
    body: { message: { data: Buffer.from(JSON.stringify({ version: "1.0", packageName: PKG, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: "1.0", notificationType: 2, purchaseToken: token, subscriptionId: PRODUCT }, ...extra })).toString("base64") } },
  });

describe("the subscription on every sign-in", () => {
  it("an unpaid owner is not active, on register, sign in and me", async () => {
    const o = await owner();
    assert.deepEqual(o.registered.subscription, { active: false, source: null, productId: null, expiresAt: null, autoRenewing: null });
    assert.equal((await me(o)).subscription.active, false);
    const login = await call("POST", "/api/auth/login", { body: { identifier: o.email, password: "Secret123" } });
    assert.equal(login.json.subscription.active, false);
  });

  it("an owner who paid on the website is active with source web, and never meets the paywall", async () => {
    const o = await owner();
    const until = new Date(Date.now() + 100 * DAY);
    await User.updateOne({ _id: o.id }, { registrationPaidUntil: until });
    const s = (await me(o)).subscription;
    assert.deepEqual({ active: s.active, source: s.source, productId: s.productId, autoRenewing: s.autoRenewing }, { active: true, source: "web", productId: null, autoRenewing: false });
    assert.equal(new Date(s.expiresAt).getTime(), until.getTime());
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 200);
  });
});

describe("POST /api/payments/play/verify", () => {
  it("confirms the purchase with Google, unlocks the account and says where the time came from", async () => {
    const o = await owner();
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 402, "held before paying");
    grant("token-ok-1".padEnd(30, "k"));
    const res = await verify(o, { purchaseToken: "token-ok-1".padEnd(30, "k") });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.subscription.active, true);
    assert.equal(res.json.subscription.source, "google_play");
    assert.equal(res.json.subscription.productId, PRODUCT);
    assert.equal(res.json.subscription.autoRenewing, true);
    assert.ok(new Date(res.json.subscription.expiresAt) > new Date(Date.now() + 360 * DAY));
    assert.deepEqual(asked.at(-1), { packageName: PKG, token: "token-ok-1".padEnd(30, "k") });
    assert.equal(acked.length, 1, "Google is told it is acknowledged");

    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 200, "unlocked");
    assert.equal((await me(o)).subscription.source, "google_play");
    assert.equal((await me(o)).registration.paid, true);
    assert.equal(await Notification.countDocuments({ user: o.id, title: "Subscription active" }), 1);
    assert.ok(!JSON.stringify(res.json).includes("token-ok-1"), "the purchase token is never returned");
  });

  it("is safe to repeat (restore) and does not announce twice", async () => {
    const o = await owner();
    const token = "token-repeat".padEnd(30, "r");
    grant(token);
    assert.equal((await verify(o, { purchaseToken: token })).status, 200);
    assert.equal((await verify(o, { purchaseToken: token })).status, 200);
    assert.equal(await PlaySubscription.countDocuments({ purchaseToken: token }), 1);
    assert.equal(await Notification.countDocuments({ user: o.id, title: "Subscription active" }), 1);
  });

  it("one purchase cannot belong to two accounts (409)", async () => {
    const a = await owner();
    const b = await owner();
    const token = "token-shared".padEnd(30, "s");
    grant(token);
    assert.equal((await verify(a, { purchaseToken: token })).status, 200);
    const stolen = await verify(b, { purchaseToken: token });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.json.error.code, "purchase_in_use");
    assert.equal((await call("GET", "/api/opportunities", { cookie: b.cookie })).status, 402, "still held");
  });

  it("refuses another app, another product, a token Google does not know, and a product that does not match", async () => {
    const o = await owner();
    grant("token-good".padEnd(30, "g"));
    const refused = [
      await verify(o, { purchaseToken: "token-good".padEnd(30, "g"), packageName: "com.someone.else" }),
      await verify(o, { purchaseToken: "token-good".padEnd(30, "g"), productId: "other_product" }),
      await verify(o, { purchaseToken: "token-made-up".padEnd(30, "m") }),
    ];
    for (const r of refused) {
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json.error.code, "invalid_purchase");
    }
    grant("token-other-product".padEnd(30, "p"), { productId: "something_else" });
    assert.equal((await verify(o, { purchaseToken: "token-other-product".padEnd(30, "p") })).json.error.code, "invalid_purchase");
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 402);
  });

  it("says pending, expired or on hold plainly, and gives no access", async () => {
    const o = await owner();
    grant("token-pending".padEnd(30, "p"), { state: "SUBSCRIPTION_STATE_PENDING" });
    const pending = await verify(o, { purchaseToken: "token-pending".padEnd(30, "p") });
    assert.equal(pending.status, 422);
    assert.equal(pending.json.error.code, "subscription_pending");
    grant("token-expired".padEnd(30, "e"), { state: "SUBSCRIPTION_STATE_EXPIRED", expiresAt: new Date(Date.now() - DAY) });
    assert.equal((await verify(o, { purchaseToken: "token-expired".padEnd(30, "e") })).json.error.code, "subscription_inactive");
    grant("token-hold".padEnd(30, "h"), { state: "SUBSCRIPTION_STATE_ON_HOLD" });
    assert.equal((await verify(o, { purchaseToken: "token-hold".padEnd(30, "h") })).json.error.code, "subscription_inactive");
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 402);
    assert.equal(acked.length, 0, "nothing is acknowledged that does not give access");
  });

  it("a cancelled subscription still gives access until it ends, and a grace period keeps access", async () => {
    const o = await owner();
    grant("token-cancel".padEnd(30, "c"), { state: "SUBSCRIPTION_STATE_CANCELED", autoRenewing: false, expiresAt: new Date(Date.now() + 20 * DAY) });
    const res = await verify(o, { purchaseToken: "token-cancel".padEnd(30, "c") });
    assert.equal(res.status, 200);
    assert.equal(res.json.subscription.autoRenewing, false);
    const grace = entitlementOf({ found: true, state: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", expiresAt: new Date(Date.now() - DAY) });
    assert.equal(grace.active, true);
    assert.ok(grace.until > new Date());
  });

  it("answers 503 when Google cannot be reached or Play is not set up, and never unlocks", async () => {
    const o = await owner();
    grant("token-down".padEnd(30, "d"));
    outage = true;
    assert.equal((await verify(o, { purchaseToken: "token-down".padEnd(30, "d") })).status, 503);
    outage = false;
    setPlay(null);
    const off = await verify(o, { purchaseToken: "token-down".padEnd(30, "d") });
    assert.equal(off.status, 503);
    assert.equal(off.json.error.code, "play_unavailable");
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 402);
  });

  it("needs an owner's sign-in, and a valid body", async () => {
    assert.equal((await call("POST", "/api/payments/play/verify", { body: { productId: PRODUCT, packageName: PKG, purchaseToken: "x".repeat(30) } })).status, 401);
    const s = await createStaff({ role: "admin" });
    const staff = await logIn(call, s.email, s.password);
    assert.equal((await call("POST", "/api/payments/play/verify", { cookie: staff.cookie, body: { productId: PRODUCT, packageName: PKG, purchaseToken: "x".repeat(30) } })).status, 403);
    const o = await owner();
    assert.equal((await call("POST", "/api/payments/play/verify", { cookie: o.cookie, body: { productId: PRODUCT } })).status, 422);
    assert.equal((await call("POST", "/api/payments/play/verify", { cookie: o.cookie, body: { productId: PRODUCT, packageName: PKG, purchaseToken: "x".repeat(30), extra: 1 } })).status, 422);
  });

  it("never shortens time that was paid on the website", async () => {
    const o = await owner();
    const web = new Date(Date.now() + 700 * DAY);
    await User.updateOne({ _id: o.id }, { registrationPaidUntil: web, subscriptionSource: "web" });
    grant("token-short".padEnd(30, "s"), { expiresAt: new Date(Date.now() + 30 * DAY) });
    const res = await verify(o, { purchaseToken: "token-short".padEnd(30, "s") });
    assert.equal(res.status, 200);
    assert.equal(res.json.subscription.source, "web");
    assert.equal(new Date(res.json.subscription.expiresAt).getTime(), web.getTime());
  });
});

describe("Google's notifications and the catch-up check", () => {
  async function subscribed(token) {
    const o = await owner();
    grant(token);
    assert.equal((await verify(o, { purchaseToken: token })).status, 200);
    return o;
  }

  it("a renewal extends the time, and a refund or expiry ends it (the paywall comes back)", async () => {
    const token = "token-renew".padEnd(30, "n");
    const o = await subscribed(token);
    const first = new Date((await me(o)).subscription.expiresAt).getTime();

    grant(token, { expiresAt: new Date(Date.now() + 730 * DAY) });
    assert.equal((await notification(token)).status, 200);
    const renewed = new Date((await me(o)).subscription.expiresAt).getTime();
    assert.ok(renewed > first + 300 * DAY);

    grant(token, { state: "SUBSCRIPTION_STATE_EXPIRED", expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await notification(token)).status, 200);
    assert.equal((await me(o)).subscription.active, false);
    assert.equal((await call("GET", "/api/opportunities", { cookie: o.cookie })).status, 402);
  });

  it("only trusts Google: the message just names a token, and the purchase is asked about again", async () => {
    const token = "token-trust".padEnd(30, "t");
    const o = await subscribed(token);
    asked.length = 0;
    // A message claiming a revoke, while Google still says active, changes nothing.
    assert.equal((await notification(token, SECRET, { subscriptionNotification: { notificationType: 12, purchaseToken: token } })).status, 200);
    assert.equal(asked.length, 1);
    assert.equal((await me(o)).subscription.active, true);
  });

  it("checks the secret, ignores tokens it does not know, and asks Pub/Sub to retry when Google is down", async () => {
    const token = "token-secret".padEnd(30, "q");
    await subscribed(token);
    assert.equal((await notification(token, "wrong-secret")).status, 401);
    assert.equal((await notification(token, null)).status, 401);
    asked.length = 0;
    assert.equal((await notification("unknown-token".padEnd(30, "u"))).status, 200);
    assert.equal(asked.length, 0, "an unknown token costs no Google call");
    assert.equal((await call("POST", `/api/webhooks/google-play?secret=${SECRET}`, { origin: null, body: { message: { data: "not-base64-json" } } })).status, 200);
    outage = true;
    assert.equal((await notification(token)).status, 503);
  });

  it("the catch-up check renews a subscription whose notification was missed, and lets an ended one lapse", async () => {
    const renewTok = "token-missed-a".padEnd(30, "a");
    const endTok = "token-missed-b".padEnd(30, "b");
    const a = await subscribed(renewTok);
    const b = await subscribed(endTok);
    const config = ctx.config;
    // Both purchases' time has run out locally.
    await PlaySubscription.updateMany({ purchaseToken: mongoose.trusted({ $in: [renewTok, endTok] }) }, { expiresAt: new Date(Date.now() - 1000) });
    await User.updateMany({ _id: mongoose.trusted({ $in: [a.id, b.id] }) }, { registrationPaidUntil: new Date(Date.now() - 1000) });
    grant(renewTok, { expiresAt: new Date(Date.now() + 365 * DAY) });
    grant(endTok, { state: "SUBSCRIPTION_STATE_EXPIRED", expiresAt: new Date(Date.now() - DAY) });
    assert.equal(await refreshLapsedPlaySubscriptions(config), 2);
    assert.equal((await me(a)).subscription.active, true);
    assert.equal((await me(b)).subscription.active, false);
  });

  it("an owner whose Play subscription renews itself gets no 'renew soon' reminder", async () => {
    const o = await owner();
    await User.updateOne({ _id: o.id }, { registrationPaidUntil: new Date(Date.now() + 2 * DAY), subscriptionSource: "google_play", subscriptionAutoRenewing: true });
    const web = await owner();
    await User.updateOne({ _id: web.id }, { registrationPaidUntil: new Date(Date.now() + 2 * DAY) });
    await runSubscriptionReminders(ctx.config);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /subscription ends/i }), 0);
    assert.equal(await Notification.countDocuments({ user: web.id, title: /subscription ends/i }), 1);
  });
});

describe("the Google Play client", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const account = JSON.stringify({ client_email: "play@nmrep-test.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.test/token" });
  const quiet = { log() {}, error() {} };

  function fakeFetch(handler) {
    const seen = [];
    const fetchImpl = async (url, init = {}) => {
      seen.push({ url, init });
      const { status = 200, json = {} } = (url.startsWith("https://oauth2.test") ? { json: { access_token: "ya29.fake", expires_in: 3600 } } : handler(url, init)) ?? {};
      return { status, ok: status >= 200 && status < 300, json: async () => json };
    };
    return { fetchImpl, seen };
  }

  it("is off without a key, and reads a key from inline JSON, a file or base64 without ever logging it", () => {
    assert.equal(createPlayClient({}, { log: quiet }).enabled, false);
    assert.equal(createPlayClient({ serviceAccountJson: account }, { log: quiet }).enabled, true);
    assert.equal(createPlayClient({ serviceAccountBase64: Buffer.from(account).toString("base64") }, { log: quiet }).enabled, true);
    const logged = [];
    const bad = createPlayClient({ serviceAccountJson: '{"client_email":"x"}' }, { log: { error: (...a) => logged.push(a.join(" ")), log() {} } });
    assert.equal(bad.enabled, false);
    assert.ok(logged.length > 0 && !logged.join(" ").includes("PRIVATE KEY"));
  });

  it("asks the subscriptionsv2 endpoint with a bearer token and reads the answer", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({
      json: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", latestOrderId: "GPA.9", acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING", lineItems: [{ productId: "nmrep_annual", expiryTime: "2030-01-01T00:00:00Z", autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: "yearly" } }] },
    }));
    const c = createPlayClient({ serviceAccountJson: account }, { fetchImpl, log: quiet });
    const r = await c.getSubscription(PKG, "tok/en");
    assert.deepEqual({ found: r.found, state: r.state, productId: r.productId, basePlanId: r.basePlanId, autoRenewing: r.autoRenewing, acknowledged: r.acknowledged, orderId: r.orderId }, { found: true, state: "SUBSCRIPTION_STATE_ACTIVE", productId: "nmrep_annual", basePlanId: "yearly", autoRenewing: true, acknowledged: false, orderId: "GPA.9" });
    assert.equal(r.expiresAt.toISOString(), "2030-01-01T00:00:00.000Z");
    const request = seen.find((s) => s.url.includes("androidpublisher"));
    assert.equal(request.url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/purchases/subscriptionsv2/tokens/tok%2Fen`);
    assert.equal(request.init.headers.Authorization, "Bearer ya29.fake");
  });

  it("a token Google does not know is 'not found', an outage or a refusal is 'unavailable'", async () => {
    let status = 404;
    const { fetchImpl } = fakeFetch(() => ({ status }));
    const c = createPlayClient({ serviceAccountJson: account }, { fetchImpl, log: quiet });
    assert.deepEqual(await c.getSubscription(PKG, "t"), { found: false });
    status = 500;
    assert.deepEqual(await c.getSubscription(PKG, "t"), { unavailable: true });
    status = 403;
    assert.deepEqual(await c.getSubscription(PKG, "t"), { unavailable: true });
  });

  it("acknowledges a subscription", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({ status: 204 }));
    const c = createPlayClient({ serviceAccountJson: account }, { fetchImpl, log: quiet });
    assert.equal(await c.acknowledge(PKG, PRODUCT, "tok"), true);
    assert.match(seen.at(-1).url, /purchases\/subscriptions\/nmrep_annual\/tokens\/tok:acknowledge$/);
  });
});

describe("the subscription view", () => {
  it("is always active while the fee is not being charged, with no source", () => {
    const view = subscriptionView({ registrationPaidUntil: null }, { payments: { enabled: false }, googlePlay: { productId: PRODUCT } });
    assert.deepEqual(view, { active: true, source: null, productId: null, expiresAt: null, autoRenewing: null });
  });
});
