import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import * as options from "../src/options.js";
import { setMailer } from "../src/lib/mailer.js";
import { Application } from "../src/models/Application.js";
import { Business } from "../src/models/Business.js";
import { ConsentRecord } from "../src/models/ConsentRecord.js";
import { Notification } from "../src/models/Notification.js";
import { Session } from "../src/models/Session.js";
import { User } from "../src/models/User.js";
import { ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The mobile app is not a browser: no Origin header, no cookies, a Bearer token and a session that slides.

let ctx;
let admin;
const fake = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  ctx = await startTestServer();
  const a = await createStaff({ role: "admin" });
  const res = await fetch(ctx.base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ email: a.email, password: a.password }) });
  admin = res.headers.getSetCookie().find((c) => c.startsWith("nmrep_session=")).split(";")[0];
});
after(async () => {
  await ctx.stop();
});
beforeEach(() => {
  fake.sent = [];
  setMailer(fake, { notifications: true, appUrl: "https://nmrep.test" });
});

/** A request the way the app sends it: no Origin, "X-Client: app", Bearer token when signed in. */
async function app(method, path, { body, token, headers = {} } = {}) {
  const h = { "X-Client": "app", ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(ctx.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, setCookie: res.headers.getSetCookie() };
}

async function register(extra = {}) {
  const body = registrationBody(extra);
  const res = await app("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { body, email: body.account.email, password: body.account.password, token: res.json.token, res };
}

describe("app mode", () => {
  it("registers and logs in without an Origin or a cookie, and returns a token with its expiry", async () => {
    const o = await register();
    assert.match(o.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(o.res.setCookie.length, 0, "no cookie for the app");
    const expires = new Date(o.res.json.tokenExpiresAt).getTime();
    assert.ok(Math.abs(expires - (Date.now() + 30 * DAY)) < 60_000, "30 days");

    const login = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password } });
    assert.equal(login.status, 200);
    assert.ok(login.json.token && login.json.tokenExpiresAt);
    assert.notEqual(login.json.token, o.token);
    assert.equal(login.setCookie.length, 0);
    const dash = await app("GET", "/api/dashboard", { token: login.json.token });
    assert.equal(dash.status, 200);
    assert.equal(dash.json.user.email, o.email);
  });

  it("the Bearer token works only for the app: without X-Client it is ignored", async () => {
    const o = await register();
    const bare = await fetch(ctx.base + "/api/dashboard", { headers: { Authorization: `Bearer ${o.token}` } });
    assert.equal(bare.status, 401);
    const other = await app("GET", "/api/dashboard", { token: o.token, headers: { "X-Client": "browser" } });
    assert.equal(other.status, 401, "only the exact value app counts");
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 200);
  });

  it("state-changing requests still need an allowed Origin unless they come from the app", async () => {
    const o = await register();
    const noHeader = await fetch(ctx.base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: o.email, password: o.password }) });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).error.code, "forbidden_origin");
    // The app header does not excuse a wrong Origin: that is a browser, and browsers get the normal check.
    const wrongOrigin = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password }, headers: { Origin: "https://evil.example" } });
    assert.equal(wrongOrigin.status, 403);
    const rightOrigin = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password }, headers: { Origin: ORIGIN } });
    assert.equal(rightOrigin.status, 200);
  });

  it("browsers cannot send the app header: it is not an allowed CORS header", async () => {
    const res = await fetch(ctx.base + "/api/auth/login", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-client,content-type" },
    });
    assert.ok(!/x-client/i.test(res.headers.get("access-control-allow-headers") ?? ""));
    assert.equal(res.headers.get("access-control-allow-origin"), null, "an unknown site gets no permission at all");
  });

  it("logout and 'log out everywhere' revoke the token", async () => {
    const o = await register();
    assert.equal((await app("POST", "/api/auth/logout", { token: o.token })).status, 204);
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 401);
    const again = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password } });
    const second = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password } });
    assert.equal((await app("DELETE", "/api/account/sessions", { token: second.json.token })).status, 204);
    assert.equal((await app("GET", "/api/dashboard", { token: again.json.token })).status, 401);
  });

  it("logging in while presenting the old token replaces it", async () => {
    const o = await register();
    const next = await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password }, token: o.token });
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 401);
    assert.equal((await app("GET", "/api/dashboard", { token: next.json.token })).status, 200);
  });

  it("the session slides while the app is used, but never beyond 90 days from the login", async () => {
    const o = await register();
    const hash = (await import("../src/lib/crypto.js")).hashToken(o.token);
    // Five days left: using the app pushes it back out to 30 days.
    await Session.updateOne({ tokenHash: hash }, { $set: { expiresAt: new Date(Date.now() + 5 * DAY) } });
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 200);
    let s = await Session.findOne({ tokenHash: hash });
    assert.ok(Math.abs(s.expiresAt.getTime() - (Date.now() + 30 * DAY)) < 60_000);
    assert.equal(s.client, "app");

    // A login 80 days ago can only be extended to day 90.
    await Session.updateOne({ tokenHash: hash }, { $set: { createdAt: new Date(Date.now() - 80 * DAY), expiresAt: new Date(Date.now() + 2 * DAY) } });
    await app("GET", "/api/dashboard", { token: o.token });
    s = await Session.findOne({ tokenHash: hash });
    assert.ok(Math.abs(s.expiresAt.getTime() - (s.createdAt.getTime() + 90 * DAY)) < 60_000, "capped at 90 days from the login");

    // Past the limit, no more extension, and then it expires.
    await Session.updateOne({ tokenHash: hash }, { $set: { createdAt: new Date(Date.now() - 95 * DAY), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 401);
  });

  it("every authenticated app response says when the token expires, and /me repeats it in the body", async () => {
    const o = await register();
    const { hashToken } = await import("../src/lib/crypto.js");
    await Session.updateOne({ tokenHash: hashToken(o.token) }, { $set: { expiresAt: new Date(Date.now() + 5 * DAY) } });

    const dash = await app("GET", "/api/dashboard", { token: o.token });
    const header = dash.headers.get("x-token-expires-at");
    assert.ok(header, "header present");
    assert.ok(Math.abs(new Date(header).getTime() - (Date.now() + 30 * DAY)) < 60_000, "shows the extended expiry, not the stale one");

    const me = await app("GET", "/api/auth/me", { token: o.token });
    assert.equal(me.json.tokenExpiresAt, header);
    assert.equal(me.headers.get("x-token-expires-at"), header);

    // Not sent without a session, and never on a website request.
    assert.equal((await app("GET", "/api/health")).headers.get("x-token-expires-at"), null);
    const reg = await fetch(ctx.base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(registrationBody()) });
    const cookie = reg.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const web = await fetch(ctx.base + "/api/auth/me", { headers: { Cookie: cookie } });
    assert.equal(web.status, 200);
    assert.equal(web.headers.get("x-token-expires-at"), null);
    assert.equal((await web.json()).tokenExpiresAt, undefined);
  });

  it("an expired app token is refused, and a website session does not slide", async () => {
    const o = await register();
    const { hashToken } = await import("../src/lib/crypto.js");
    await Session.updateOne({ tokenHash: hashToken(o.token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 401);

    const body = registrationBody();
    const reg = await fetch(ctx.base + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body) });
    const cookie = reg.headers.getSetCookie().find((c) => c.startsWith("nmrep_session=")).split(";")[0];
    const web = await Session.findOne({ user: (await User.findOne({ email: body.account.email }))._id });
    assert.equal(web.client, "web");
    await Session.updateOne({ _id: web._id }, { $set: { expiresAt: new Date(Date.now() + 2 * DAY) } });
    await fetch(ctx.base + "/api/dashboard", { headers: { Cookie: cookie } });
    const after = await Session.findById(web._id);
    assert.ok(Math.abs(after.expiresAt.getTime() - (Date.now() + 2 * DAY)) < 60_000, "unchanged");
  });

  it("staff and partners can sign in through the app header too, so the app can tell them apart by role", async () => {
    const s = await createStaff({ role: "admin" });
    const res = await app("POST", "/api/auth/login", { body: { email: s.email, password: s.password } });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.role, "admin");
    assert.equal(res.json.business, null);
  });
});

describe("deleting an account", () => {
  async function ownerWithData() {
    const o = await register({ business: { businessName: "Delete Me Ltd" } });
    const created = await fetch(ctx.base + "/api/admin/opportunities", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: admin }, body: JSON.stringify({ title: "Delete test", provider: "NMREP", type: "Grant", description: "x" }) });
    const id = (await created.json()).opportunity.id;
    await fetch(ctx.base + `/api/admin/opportunities/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: admin }, body: JSON.stringify({ status: "Open" }) });
    const sub = await app("POST", "/api/applications", { token: o.token, body: { opportunityId: id, submit: true, consent: { summary: true } } });
    assert.equal(sub.status, 201, JSON.stringify(sub.json));
    return { ...o, opportunityId: id };
  }

  it("needs the password, and the wrong one changes nothing", async () => {
    const o = await register();
    const wrong = await app("DELETE", "/api/account", { token: o.token, body: { password: "WrongPass1" } });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.json.error.fields.password);
    assert.equal((await app("DELETE", "/api/account", { token: o.token, body: {} })).status, 422);
    assert.equal((await app("DELETE", "/api/account", { token: o.token, body: { password: o.password, confirm: true } })).status, 422, "no unknown fields");
    assert.equal((await app("DELETE", "/api/account", { body: { password: o.password } })).status, 401, "signed in only");
    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 200, "still there");
  });

  it("removes the account and everything personal, keeps an ended consent record, and tells the owner by email", async () => {
    const o = await ownerWithData();
    const user = await User.findOne({ email: o.email });
    const businessId = (await Business.findOne({ owner: user._id }))._id;
    assert.equal(await Application.countDocuments({ owner: user._id }), 1);
    assert.ok((await ConsentRecord.countDocuments({ owner: user._id, revokedAt: null })) === 1);
    fake.sent = [];

    const res = await app("DELETE", "/api/account", { token: o.token, body: { password: o.password } });
    assert.equal(res.status, 204);
    assert.equal(await User.countDocuments({ email: o.email }), 0);
    assert.equal(await Business.countDocuments({ _id: businessId }), 0);
    assert.equal(await Application.countDocuments({ owner: user._id }), 0);
    assert.equal(await Notification.countDocuments({ user: user._id }), 0);
    assert.equal(await Session.countDocuments({ user: user._id }), 0);
    const consents = await ConsentRecord.find({ owner: user._id });
    assert.equal(consents.length, 1, "kept as a record of what was shared");
    assert.ok(consents[0].revokedAt);
    assert.equal(consents[0].revokedReason, "Account deleted");

    const mail = fake.sent.find((m) => /account has been deleted/.test(m.subject));
    assert.ok(mail && mail.to === o.email);
    assert.ok(!mail.text.includes("Delete Me Ltd"), "no business details in the email");

    assert.equal((await app("GET", "/api/dashboard", { token: o.token })).status, 401);
    assert.equal((await app("POST", "/api/auth/login", { body: { email: o.email, password: o.password } })).status, 401);
    // The same address can be used to register again.
    assert.equal((await app("POST", "/api/auth/register", { body: { ...o.body } })).status, 201);
  });

  it("staff and partner accounts cannot delete themselves this way", async () => {
    const s = await createStaff({ role: "admin" });
    const login = await app("POST", "/api/auth/login", { body: { email: s.email, password: s.password } });
    const res = await app("DELETE", "/api/account", { token: login.json.token, body: { password: s.password } });
    assert.equal(res.status, 403);
    assert.equal(await User.countDocuments({ email: s.email }), 1);
  });

  it("a deleted owner disappears from admin lists and reports", async () => {
    const o = await register({ business: { businessName: "Ghost Business Zed" } });
    await app("DELETE", "/api/account", { token: o.token, body: { password: o.password } });
    const list = await fetch(ctx.base + "/api/admin/businesses?q=Ghost%20Business%20Zed", { headers: { Cookie: admin } });
    assert.equal((await list.json()).total, 0);
  });
});

describe("reference data", () => {
  it("is public, cacheable and lists every allowed value", async () => {
    const res = await fetch(ctx.base + "/api/reference");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /public, max-age=3600/);
    assert.ok(res.headers.get("etag"));
    const data = await res.json();
    assert.equal(data.version, 1);
    for (const key of ["businessTypes", "sectors", "states", "ownerRoles", "ownershipStructures", "annualRevenues", "existingLoans", "fundingNeeds", "yesNo", "verificationStatuses"]) {
      assert.deepEqual(data[key], options[key], key);
    }
    assert.deepEqual(data.opportunityTypes, ["Funding", "Grant", "Loan", "Training", "Support"]);
    assert.ok(data.applicationStatuses.includes("More Information Required"));
    assert.deepEqual(data.sharingCategories.map((c) => c.key), ["summary", "contact", "profile"]);
    assert.equal(data.sharingCategories[0].required, true);
    // fetch adds "Cache-Control: no-cache" to a conditional request, which defeats the check, so ask with plain http.
    const status = await new Promise((resolve, reject) => {
      http.get(ctx.base + "/api/reference", { headers: { "If-None-Match": res.headers.get("etag") } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject);
    });
    assert.equal(status, 304, "an app can revalidate cheaply");
  });

  it("every value it lists is accepted by the API, so the app can build forms from it", async () => {
    const data = await (await fetch(ctx.base + "/api/reference")).json();
    const body = registrationBody({ business: { sector: data.sectors.at(-1), state: data.states.at(-1), businessType: data.businessTypes[0], annualRevenue: data.annualRevenues.at(-1) } });
    const res = await app("POST", "/api/auth/register", { body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(mongoose.connection.readyState === 1);
  });
});
