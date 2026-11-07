import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPushSender, setPushSender } from "../src/lib/push.js";
import { Device } from "../src/models/Device.js";
import { Session } from "../src/models/Session.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The app's push contract: devicePushToken at sign-in and sign-up, POST /api/account/push-token, sign out stops delivery,
// every alert is also an inbox row, and the payload carries channelId "alerts" and data.link.

let ctx;
let call;
let admin;
let n = 0;
const sent = [];
const tok = () => `ExponentPushToken[contract${String((n += 1)).padStart(4, "0")}abcdefghijkl]`;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
  setPushSender({ enabled: true, firebase: false, async send(messages) { sent.push(...messages); return { sent: messages.length, invalidTokens: [] }; } });
});
after(async () => {
  setPushSender(createPushSender(null));
  await ctx.stop();
});

async function owner(extra = {}) {
  const body = registrationBody();
  const res = await call("POST", "/api/auth/register", { body: { ...body, ...extra } });
  assert.equal(res.status, 201, res.text);
  return { cookie: res.cookie, user: res.json.user, email: body.account.email, password: body.account.password, businessId: res.json.business.id, res };
}
const login = (o, devicePushToken) => call("POST", "/api/auth/login", { body: { identifier: o.email, password: o.password, ...(devicePushToken === undefined ? {} : { devicePushToken }) } });
const pushTo = (token) => sent.filter((m) => m.to === token);
const trigger = (o, status) => call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status, note: "Private staff note" } });

describe("devicePushToken at sign-up and sign-in", () => {
  it("is optional: missing and an empty string are both fine and save nothing", async () => {
    const o = await owner();
    assert.equal((await login(o)).status, 200);
    const empty = await login(o, "");
    assert.equal(empty.status, 200);
    assert.equal("pushTokenSaved" in empty.json, false);
    assert.equal(await Device.countDocuments({ user: o.user.id }), 0);
    const reg = await owner({ devicePushToken: "" });
    assert.equal(await Device.countDocuments({ user: reg.user.id }), 0);
  });

  it("saves a token sent with sign-up, and with sign-in, tied to that sign-in", async () => {
    const t1 = tok();
    const o = await owner({ devicePushToken: t1 });
    assert.equal(o.res.json.pushTokenSaved, true);
    const device = await Device.findOne({ token: t1 });
    assert.equal(String(device.user), o.user.id);
    assert.ok(device.session, "tied to the sign-in that brought it");
    assert.ok(await Session.exists({ _id: device.session }));

    const t2 = tok();
    const again = await login(o, t2);
    assert.equal(again.json.pushTokenSaved, true);
    assert.equal(await Device.countDocuments({ user: o.user.id }), 2, "a second sign-in is a second phone");
  });

  it("does not fail the sign-in over a token that is not a push token", async () => {
    const o = await owner();
    const res = await login(o, "definitely-not-a-token");
    assert.equal(res.status, 200);
    assert.equal(res.json.pushTokenSaved, false);
    assert.equal(await Device.countDocuments({ user: o.user.id }), 0);
  });

  it("moves a token to whoever signs in on that phone", async () => {
    const a = await owner();
    const b = await owner();
    const t = tok();
    await login(a, t);
    await login(b, t);
    assert.equal(String((await Device.findOne({ token: t })).user), b.user.id);
  });
});

describe("POST /api/account/push-token", () => {
  it("needs a signed-in account and a valid token", async () => {
    assert.equal((await call("POST", "/api/account/push-token", { body: { devicePushToken: tok() } })).status, 401);
    const o = await owner();
    const bad = await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: "nope" } });
    assert.equal(bad.status, 422);
    assert.match(bad.json.error.fields.devicePushToken, /push token/);
    assert.equal((await call("POST", "/api/account/push-token", { cookie: o.cookie, body: {} })).status, 422);
    assert.equal((await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: tok(), extra: 1 } })).status, 422);
  });

  it("saves the token, and a later call replaces it for the same sign-in", async () => {
    const o = await owner();
    const first = tok();
    const second = tok();
    assert.deepEqual((await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: first } })).json, { registered: true });
    assert.deepEqual((await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: first } })).json, { registered: true }, "safe to repeat");
    await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: second } });
    const mine = await Device.find({ user: o.user.id });
    assert.deepEqual(mine.map((d) => d.token), [second], "the new token replaced the old one");
  });

  it("replaces only this sign-in's token, not another phone's", async () => {
    const o = await owner();
    const phoneA = tok();
    const phoneB = tok();
    const sessionA = await login(o);
    const sessionB = await login(o);
    await call("POST", "/api/account/push-token", { cookie: sessionA.cookie, body: { devicePushToken: phoneA } });
    await call("POST", "/api/account/push-token", { cookie: sessionB.cookie, body: { devicePushToken: phoneB } });
    assert.equal(await Device.countDocuments({ user: o.user.id }), 2);
    await call("POST", "/api/account/push-token", { cookie: sessionA.cookie, body: { devicePushToken: tok() } });
    assert.ok(await Device.exists({ token: phoneB }), "the other phone keeps its token");
    assert.equal(await Device.exists({ token: phoneA }), null);
  });

  it("an empty string stops push to this sign-in", async () => {
    const o = await owner();
    const t = tok();
    await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: t } });
    assert.deepEqual((await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: "" } })).json, { registered: false });
    assert.equal(await Device.countDocuments({ user: o.user.id }), 0);
  });
});

describe("signing out stops delivery", () => {
  it("logout stops push to that sign-in's token only", async () => {
    const o = await owner();
    const a = await login(o, tok());
    const tA = (await Device.findOne({ user: o.user.id }).sort({ createdAt: -1 })).token;
    const b = await login(o, tok());
    const tB = (await Device.findOne({ user: o.user.id }).sort({ createdAt: -1 })).token;
    assert.notEqual(tA, tB);
    sent.length = 0;
    assert.equal((await call("POST", "/api/auth/logout", { cookie: a.cookie })).status, 204);
    assert.equal(await Device.exists({ token: tA }), null);
    await trigger(o, "Pending Verification");
    assert.equal(pushTo(tA).length, 0, "no push after logout");
    assert.equal(pushTo(tB).length, 1, "the other phone still gets it");
    assert.ok(b);
  });

  it("DELETE /api/account/sessions stops push to every phone of the account", async () => {
    const o = await owner();
    const s = await login(o, tok());
    await login(o, tok());
    assert.ok((await Device.countDocuments({ user: o.user.id })) >= 2);
    assert.equal((await call("DELETE", "/api/account/sessions", { cookie: s.cookie })).status, 204);
    assert.equal(await Device.countDocuments({ user: o.user.id }), 0);
    sent.length = 0;
    await trigger(o, "Pending Verification");
    assert.equal(sent.filter((m) => /verification/i.test(m.title)).length, 0);
  });

  it("a sign-in that ended some other way (expired, removed) is never pushed to, and its token is forgotten", async () => {
    const o = await owner();
    const t = tok();
    await login(o, t);
    const device = await Device.findOne({ token: t });
    await Session.deleteOne({ _id: device.session }); // for example a password change signed everyone out
    sent.length = 0;
    await trigger(o, "Pending Verification");
    assert.equal(pushTo(t).length, 0);
    assert.equal(await Device.exists({ token: t }), null);
  });
});

describe("what a push carries", () => {
  it("is also a row in the inbox, and carries channelId alerts data, the inbox link, type and the row's id", async () => {
    const o = await owner();
    const t = tok();
    await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: t } });
    sent.length = 0;
    await trigger(o, "Verified");
    const push = pushTo(t)[0];
    assert.ok(push, "pushed");
    assert.equal(push.data.link, "/notifications");
    assert.equal(push.data.type, "verification");
    const inbox = await call("GET", "/api/notifications", { cookie: o.cookie });
    const row = inbox.json.items.find((i) => i.id === push.data.notificationId);
    assert.ok(row, "the same alert is in GET /api/notifications");
    assert.match(row.title, /Verified/);
    assert.ok(!JSON.stringify(push).includes("Private staff note"));
  });
});

describe("the Expo and Firebase senders", () => {
  const expoOk = (tickets) => async (url, init) => {
    assert.equal(url, "https://exp.host/--/api/v2/push/send");
    return new Response(JSON.stringify({ data: tickets(JSON.parse(init.body)) }), { status: 200 });
  };

  it("sends Expo tokens to Expo with channelId alerts, a sound and high priority, and the data as given", async () => {
    let body;
    const sender = createPushSender({ enabled: true, credentials: null, expo: { accessToken: "" } }, { fetchImpl: async (url, init) => ((body = JSON.parse(init.body)), expoOk((b) => b.map(() => ({ status: "ok" })))(url, init)), log: { error() {} } });
    const r = await sender.send([{ to: tok(), title: "Hello", body: "", data: { link: "/notifications", type: "test" } }]);
    assert.equal(r.sent, 1);
    assert.equal(body[0].channelId, "alerts");
    assert.equal(body[0].sound, "default");
    assert.equal(body[0].priority, "high");
    assert.deepEqual(body[0].data, { link: "/notifications", type: "test" });
    assert.ok(!("body" in body[0]), "no empty body");
  });

  it("reports an Expo token that is no longer a working phone, and survives Expo failing", async () => {
    const dead = tok();
    const ok = tok();
    const sender = createPushSender({ enabled: true, credentials: null }, { fetchImpl: expoOk((b) => b.map((m) => (m.to === dead ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" }))), log: { error() {} } });
    const r = await sender.send([{ to: dead, title: "x", data: {} }, { to: ok, title: "x", data: {} }]);
    assert.deepEqual(r, { sent: 1, invalidTokens: [dead] });
    const down = createPushSender({ enabled: true, credentials: null }, { fetchImpl: async () => { throw new Error("down"); }, log: { error() {} } });
    assert.deepEqual(await down.send([{ to: tok(), title: "x", data: {} }]), { sent: 0, invalidTokens: [] });
  });

  it("sends each kind of token to its own service, and skips Firebase tokens when there is no Firebase key", async () => {
    const urls = [];
    const logs = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 });
    };
    const fcmToken = `phone:APA91b${"x".repeat(120)}`;
    const noKey = createPushSender({ enabled: true, credentials: null }, { fetchImpl, log: { error: (m) => logs.push(m) } });
    const r = await noKey.send([{ to: tok(), title: "a", data: {} }, { to: fcmToken, title: "b", data: {} }]);
    assert.equal(r.sent, 1);
    assert.deepEqual(urls, ["https://exp.host/--/api/v2/push/send"]);
    assert.match(logs.join(" "), /no Firebase service account key/);
    assert.ok(!logs.join(" ").includes(fcmToken));

    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const credentials = { clientEmail: "a@b.iam.gserviceaccount.com", privateKey, projectId: "nmrep-test", tokenUri: "https://oauth2.googleapis.test/token" };
    urls.length = 0;
    const both = createPushSender({ enabled: true, credentials }, {
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
        if (url.includes("exp.host")) return new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 });
        return new Response("{}", { status: 200 });
      },
      log: { error() {} },
    });
    const r2 = await both.send([{ to: tok(), title: "a", data: {} }, { to: fcmToken, title: "b", data: {} }]);
    assert.equal(r2.sent, 2);
    assert.ok(urls.some((u) => u.includes("exp.host")) && urls.some((u) => u.includes("fcm.googleapis.com")));
  });
});

describe("the older device endpoints", () => {
  it("also accept Expo tokens, tie them to the sign-in, and never show the session", async () => {
    const o = await owner();
    const t = tok();
    const res = await call("POST", "/api/devices", { cookie: o.cookie, body: { token: t, platform: "ios" } });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.json.device).sort(), ["createdAt", "id", "lastSeenAt", "platform", "token"].sort());
    assert.ok((await Device.findOne({ token: t })).session, "tied to the sign-in");
    await call("POST", "/api/auth/logout", { cookie: o.cookie });
    assert.equal(await Device.exists({ token: t }), null, "signing out stops delivery to it");
  });
});

describe("deleting the account", () => {
  it("needs the password, then removes the account, its sign-ins and its push tokens", async () => {
    const o = await owner();
    const t = tok();
    await call("POST", "/api/account/push-token", { cookie: o.cookie, body: { devicePushToken: t } });
    const wrong = await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Wrong-pass-1" } });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.json.error.fields.password);
    assert.ok(await Device.exists({ token: t }), "nothing deleted on a wrong password");
    assert.equal((await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: o.password } })).status, 204);
    assert.equal(await Device.exists({ token: t }), null);
    assert.equal(await Session.countDocuments({ user: o.user.id }), 0);
    assert.equal((await login(o)).status, 401, "the account is gone");
  });
});
