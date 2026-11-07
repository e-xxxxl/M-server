import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createPushSender, loadFirebaseCredentials } from "../src/lib/push.js";

// The Firebase Cloud Messaging sender, against a stand-in for Google: sign-in with the service account, the message
// shape, token reuse, forgetting dead phones, and never writing a secret to the log.

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const account = { type: "service_account", project_id: "nmrep-test", client_email: "push@nmrep-test.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.googleapis.test/token" };
const credentials = { clientEmail: account.client_email, privateKey, projectId: "nmrep-test", tokenUri: account.token_uri };
const T = (i) => `phone${i}:APA91b${"x".repeat(120)}`;

function harness({ onSend, onToken } = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === account.token_uri) {
      const r = onToken ? onToken(init) : { status: 200, json: { access_token: `ya29.token${calls.filter((c) => c.url === account.token_uri).length}`, expires_in: 3600 } };
      return new Response(JSON.stringify(r.json), { status: r.status });
    }
    const body = JSON.parse(init.body);
    const r = onSend ? onSend(body.message, init) : { status: 200, json: { name: "projects/x/messages/1" } };
    return new Response(JSON.stringify(r.json), { status: r.status });
  };
  const log = { error: (...a) => logs.push(a.join(" ")), log: (...a) => logs.push(a.join(" ")) };
  let clock = 1_800_000_000_000;
  const sender = createPushSender({ enabled: true, credentials }, { fetchImpl, log, now: () => clock });
  return { sender, calls, logs, advance: (ms) => (clock += ms) };
}
const sends = (h) => h.calls.filter((c) => c.url.includes("fcm.googleapis.com"));

describe("signing in to Firebase", () => {
  it("sends a signed token request built from the service account, and uses the answer as a bearer token", async () => {
    const h = harness();
    await h.sender.send([{ to: T(1), title: "Hello", body: "", data: { link: "/dashboard/", type: "test" } }]);
    const tokenCall = h.calls.find((c) => c.url === account.token_uri);
    const form = new URLSearchParams(tokenCall.init.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [head, claims, sig] = form.get("assertion").split(".");
    assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "RS256", typ: "JWT" });
    const c = JSON.parse(Buffer.from(claims, "base64url"));
    assert.equal(c.iss, account.client_email);
    assert.equal(c.scope, "https://www.googleapis.com/auth/firebase.messaging");
    assert.equal(c.aud, account.token_uri);
    assert.equal(c.exp - c.iat, 3600);
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(sig, "base64url")), "signed with the service account's private key");
    assert.equal(sends(h)[0].init.headers.Authorization, "Bearer ya29.token1");
  });

  it("reuses the access token until it is about to expire, then asks again", async () => {
    const h = harness();
    await h.sender.send([{ to: T(1), title: "a", data: {} }]);
    await h.sender.send([{ to: T(2), title: "b", data: {} }]);
    assert.equal(h.calls.filter((c) => c.url === account.token_uri).length, 1);
    h.advance(3600 * 1000);
    await h.sender.send([{ to: T(3), title: "c", data: {} }]);
    assert.equal(h.calls.filter((c) => c.url === account.token_uri).length, 2);
  });

  it("gets a new access token once when Firebase says the old one is not accepted", async () => {
    let first = true;
    const h = harness({ onSend: () => (first ? ((first = false), { status: 401, json: { error: { status: "UNAUTHENTICATED" } } }) : { status: 200, json: {} }) });
    const r = await h.sender.send([{ to: T(1), title: "a", data: {} }]);
    assert.equal(r.sent, 1);
    assert.equal(h.calls.filter((c) => c.url === account.token_uri).length, 2);
  });

  it("sends nothing and says why, without the key, when Google refuses the sign-in", async () => {
    const h = harness({ onToken: () => ({ status: 400, json: { error: "invalid_grant" } }) });
    const r = await h.sender.send([{ to: T(1), title: "a", data: {} }]);
    assert.deepEqual(r, { sent: 0, invalidTokens: [] });
    assert.equal(sends(h).length, 0);
    assert.match(h.logs.join("\n"), /access token: HTTP 400/);
    assert.ok(!h.logs.join("\n").includes("PRIVATE KEY"));
  });
});

describe("the message", () => {
  it("goes to the project's send address with a notification, string only data, and high priority on both phone systems", async () => {
    const h = harness();
    await h.sender.send([{ to: T(1), title: "Your application", body: "Open it", data: { link: "/dashboard/applications/", type: "application", notificationId: 12345 } }]);
    const call = sends(h)[0];
    assert.equal(call.url, "https://fcm.googleapis.com/v1/projects/nmrep-test/messages:send");
    const { message } = JSON.parse(call.init.body);
    assert.equal(message.token, T(1));
    assert.deepEqual(message.notification, { title: "Your application", body: "Open it" });
    assert.deepEqual(message.data, { link: "/dashboard/applications/", type: "application", notificationId: "12345" });
    assert.equal(message.android.priority, "HIGH");
    assert.equal(message.apns.headers["apns-priority"], "10");
    assert.equal(message.apns.payload.aps.sound, "default");
  });

  it("leaves the body out when there is none, so a headline-only push carries no text", async () => {
    const h = harness();
    await h.sender.send([{ to: T(1), title: "Your verification status", body: "", data: {} }]);
    assert.deepEqual(JSON.parse(sends(h)[0].init.body).message.notification, { title: "Your verification status" });
  });

  it("sends many messages in a few at a time and counts the accepted ones", async () => {
    const h = harness();
    const r = await h.sender.send(Array.from({ length: 45 }, (_, i) => ({ to: T(i), title: "x", data: {} })));
    assert.equal(r.sent, 45);
    assert.equal(sends(h).length, 45);
  });
});

describe("answers from Firebase", () => {
  const unregistered = { status: 404, json: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } };
  const badToken = { status: 400, json: { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } } };

  it("reports phones that no longer exist so they can be forgotten", async () => {
    const h = harness({ onSend: (m) => (m.token === T(2) ? unregistered : m.token === T(3) ? badToken : { status: 200, json: {} }) });
    const r = await h.sender.send([T(1), T(2), T(3)].map((to) => ({ to, title: "x", data: {} })));
    assert.equal(r.sent, 1);
    assert.deepEqual(r.invalidTokens.sort(), [T(2), T(3)].sort());
  });

  it("does not treat a bad message as a dead phone, and keeps going after a one-off failure", async () => {
    const h = harness({ onSend: (m) => (m.token === T(1) ? { status: 400, json: { error: { status: "INVALID_ARGUMENT", message: "Invalid data payload" } } } : m.token === T(2) ? { status: 503, json: {} } : { status: 200, json: {} }) });
    const r = await h.sender.send([T(1), T(2), T(3)].map((to) => ({ to, title: "x", data: {} })));
    assert.equal(r.sent, 1);
    assert.deepEqual(r.invalidTokens, []);
  });

  it("stops after a refusal of our own credentials, and logs only the status", async () => {
    const h = harness({ onSend: () => ({ status: 403, json: { error: { status: "PERMISSION_DENIED", message: "secret detail" } } }) });
    const r = await h.sender.send(Array.from({ length: 60 }, (_, i) => ({ to: T(i), title: "x", data: {} })));
    assert.equal(r.sent, 0);
    assert.ok(sends(h).length <= 20, "the rest were not tried");
    assert.match(h.logs.join("\n"), /HTTP 403/);
    assert.ok(!h.logs.join("\n").includes("secret detail"));
  });

  it("survives a network failure", async () => {
    const logs = [];
    const sender = createPushSender({ enabled: true, credentials }, { fetchImpl: async (url) => { if (url === account.token_uri) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })); throw new Error("down"); }, log: { error: (...a) => logs.push(a.join(" ")) } });
    assert.deepEqual(await sender.send([{ to: T(1), title: "x", data: {} }]), { sent: 0, invalidTokens: [] });
  });

  it("never logs a device token or message text", async () => {
    const h = harness({ onSend: () => ({ status: 500, json: {} }) });
    await h.sender.send([{ to: T(9), title: "Private headline", body: "Private body", data: {} }]);
    const text = h.logs.join("\n");
    assert.ok(!text.includes(T(9)) && !text.includes("Private"));
  });
});

describe("switching it on", () => {
  it("is off without credentials, and off when switched off on purpose", () => {
    assert.equal(createPushSender(null).enabled, false);
    assert.equal(createPushSender({ enabled: true, credentials: null }).enabled, false);
    assert.equal(createPushSender({ enabled: false, credentials }).enabled, false);
    assert.equal(createPushSender({ enabled: true, credentials }).enabled, true);
  });

  it("reads the service account from a file or from base64, and from nothing else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-fcm-"));
    const file = path.join(dir, "key.json");
    fs.writeFileSync(file, JSON.stringify(account));
    const quiet = { error() {} };
    const fromFile = loadFirebaseCredentials({ serviceAccountFile: file }, { log: quiet });
    assert.deepEqual(fromFile, credentials);
    const fromText = loadFirebaseCredentials({ serviceAccountBase64: Buffer.from(JSON.stringify(account)).toString("base64") }, { log: quiet });
    assert.equal(fromText.clientEmail, account.client_email);
    assert.equal(loadFirebaseCredentials({}, { log: quiet }), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unreadable or incomplete key, and the log never contains the key", () => {
    const logs = [];
    const log = { error: (...a) => logs.push(a.join(" ")) };
    assert.equal(loadFirebaseCredentials({ serviceAccountFile: path.join(os.tmpdir(), "does-not-exist.json") }, { log }), null);
    assert.equal(loadFirebaseCredentials({ serviceAccountBase64: Buffer.from("not json").toString("base64") }, { log }), null);
    assert.equal(loadFirebaseCredentials({ serviceAccountBase64: Buffer.from(JSON.stringify({ ...account, private_key: "nope" })).toString("base64") }, { log }), null);
    assert.equal(loadFirebaseCredentials({ serviceAccountBase64: Buffer.from(JSON.stringify({ ...account, token_uri: "http://insecure.example" })).toString("base64") }, { log }), null);
    assert.equal(logs.length, 4);
    assert.ok(!logs.join("\n").includes("PRIVATE KEY") && !logs.join("\n").includes(account.client_email));
  });

  it("lets the project id be overridden", () => {
    const loaded = loadFirebaseCredentials({ serviceAccountBase64: Buffer.from(JSON.stringify(account)).toString("base64"), projectId: "other-project" }, { log: { error() {} } });
    assert.equal(loaded.projectId, "other-project");
  });
});
