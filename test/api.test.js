import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { Session } from "../src/models/Session.js";
import { User } from "../src/models/User.js";
import { ORIGIN, client, registrationBody, startExtraApp, startTestServer } from "./helpers.js";

let ctx;
let call;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
});
after(async () => {
  await ctx.stop();
});

async function signUp(overrides) {
  const body = registrationBody(overrides);
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { body, res, cookie: res.cookie, email: body.account.email };
}

describe("health", () => {
  it("reports ok and database state", async () => {
    const res = await call("GET", "/api/health", { origin: null });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: "ok", database: true });
  });

  it("sends security headers and no-store caching, and hides the framework", async () => {
    const res = await call("GET", "/api/health", { origin: null });
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("registration", () => {
  it("creates the account and business, starts a session, and never returns the password hash", async () => {
    const { res, body } = await signUp();
    assert.equal(res.json.user.email, body.account.email);
    assert.equal(res.json.business.businessName, "Obi Fabrics");
    assert.equal(res.json.business.verificationStatus, "Unverified");
    assert.equal(res.json.business.nmrepId, null);
    assert.equal(res.json.business.yearEstablished, 2019);
    assert.ok(!JSON.stringify(res.json).includes("passwordHash"));
    assert.ok(!JSON.stringify(res.json).includes(body.account.password));
  });

  it("sets an httpOnly, SameSite=Lax session cookie", async () => {
    const { res } = await signUp();
    assert.match(res.setCookie, /HttpOnly/i);
    assert.match(res.setCookie, /SameSite=Lax/i);
    assert.match(res.setCookie, /Path=\//i);
  });

  it("stores only a bcrypt hash of the password and only a hash of the session token", async () => {
    const { body, res } = await signUp();
    const user = await User.findOne({ email: body.account.email }).select("+passwordHash");
    assert.match(user.passwordHash, /^\$2[aby]\$/);
    assert.notEqual(user.passwordHash, body.account.password);
    const token = res.cookie.split("=")[1];
    const sessions = await Session.find({ user: user._id });
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].tokenHash, token);
    assert.equal(sessions[0].tokenHash.length, 64);
  });

  it("rejects a duplicate email, ignoring case", async () => {
    const first = await signUp();
    const dup = registrationBody({ account: { email: first.email.toUpperCase() } });
    const res = await call("POST", "/api/auth/register", { body: dup });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "email_taken");
  });

  it("validates fields on the server and reports which ones failed", async () => {
    const body = registrationBody({
      account: { email: "nope", password: "short", phone: "abc" },
      business: { businessName: "", state: "Atlantis", yearEstablished: "1800", employees: "-3" },
    });
    const res = await call("POST", "/api/auth/register", { body });
    assert.equal(res.status, 422);
    const f = res.json.error.fields;
    for (const key of [
      "account.email", "account.password", "account.phone", "business.businessName",
      "business.state", "business.yearEstablished", "business.employees",
    ]) {
      assert.ok(f[key], `expected an error for ${key}`);
    }
  });

  it("requires the terms and the accuracy confirmation", async () => {
    const res = await call("POST", "/api/auth/register", { body: registrationBody({ top: { acceptedTerms: false } }) });
    assert.equal(res.status, 422);
    assert.ok(res.json.error.fields.acceptedTerms);
  });

  it("rejects fields a client must never set (mass assignment)", async () => {
    const b1 = registrationBody();
    b1.business.verificationStatus = "Verified";
    assert.equal((await call("POST", "/api/auth/register", { body: b1 })).status, 422);

    const b2 = registrationBody();
    b2.business.nmrepId = "NMREP-2026-0001";
    assert.equal((await call("POST", "/api/auth/register", { body: b2 })).status, 422);

    const b3 = registrationBody();
    b3.account.role = "admin";
    assert.equal((await call("POST", "/api/auth/register", { body: b3 })).status, 422);
  });

  it("rejects MongoDB operator objects in place of strings", async () => {
    const body = registrationBody();
    body.account.email = { $gt: "" };
    assert.equal((await call("POST", "/api/auth/register", { body })).status, 422);
    const login = await call("POST", "/api/auth/login", { body: { email: { $ne: null }, password: { $ne: null } } });
    assert.equal(login.status, 422);
  });

  it("does not leave an account behind without a business", async () => {
    const before = await User.countDocuments();
    const body = registrationBody({ business: { yearEstablished: "1800" } });
    await call("POST", "/api/auth/register", { body });
    assert.equal(await User.countDocuments(), before);
  });
});

describe("login, session and logout", () => {
  it("logs in with the right password and returns the dashboard data", async () => {
    const { body } = await signUp();
    const res = await call("POST", "/api/auth/login", { body: { email: body.account.email.toUpperCase(), password: "Secret123" } });
    assert.equal(res.status, 200);
    assert.ok(res.cookie);
    assert.equal(res.json.business.businessName, "Obi Fabrics");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const { body } = await signUp();
    const wrong = await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Wrong1234" } });
    const unknown = await call("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "Wrong1234" } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.json, unknown.json);
    assert.equal(wrong.cookie, null);
  });

  it("locks the account after repeated failures, even for the correct password, then unlocks", async () => {
    const { body } = await signUp();
    const email = body.account.email;
    for (let i = 0; i < 5; i += 1) {
      const r = await call("POST", "/api/auth/login", { body: { email, password: "Wrong1234" } });
      assert.equal(r.status, 401);
    }
    const locked = await call("POST", "/api/auth/login", { body: { email, password: "Secret123" } });
    assert.equal(locked.status, 401);
    assert.equal(locked.cookie, null);

    await User.updateOne({ email }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
    const ok = await call("POST", "/api/auth/login", { body: { email, password: "Secret123" } });
    assert.equal(ok.status, 200);
  });

  it("returns the current user for a valid session and 401 without one", async () => {
    const { cookie, email } = await signUp();
    const me = await call("GET", "/api/auth/me", { cookie, origin: null });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, email);
    assert.equal((await call("GET", "/api/auth/me", { origin: null })).status, 401);
    assert.equal((await call("GET", "/api/auth/me", { cookie: "nmrep_session=garbage", origin: null })).status, 401);
  });

  it("rejects an expired session", async () => {
    const { cookie } = await signUp();
    await Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 401);
  });

  it("logs out: the old cookie stops working", async () => {
    const { cookie } = await signUp();
    const out = await call("POST", "/api/auth/logout", { cookie });
    assert.equal(out.status, 204);
    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 401);
  });

  it("replaces the session on every login", async () => {
    const { body, cookie } = await signUp();
    const again = await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Secret123" }, cookie });
    assert.notEqual(again.cookie, cookie);
    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 401);
    assert.equal((await call("GET", "/api/auth/me", { cookie: again.cookie, origin: null })).status, 200);
  });
});

describe("request safety", () => {
  it("rejects state-changing requests without an allowed Origin", async () => {
    const { cookie } = await signUp();
    const none = await call("POST", "/api/auth/logout", { cookie, origin: null });
    const evil = await call("POST", "/api/auth/logout", { cookie, origin: "https://evil.example" });
    assert.equal(none.status, 403);
    assert.equal(evil.status, 403);
    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 200, "session must be untouched");
  });

  it("answers CORS preflight only for allowed origins, with credentials", async () => {
    const res = await fetch(`${ctx.base}/api/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    const bad = await fetch(`${ctx.base}/api/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  });

  it("handles malformed and oversized bodies without leaking details", async () => {
    const bad = await call("POST", "/api/auth/login", { raw: "{not json" });
    assert.equal(bad.status, 400);
    const big = await call("POST", "/api/auth/login", { raw: JSON.stringify({ email: "a@b.co", password: "x".repeat(30000) }) });
    assert.equal(big.status, 413);
    for (const r of [bad, big]) assert.ok(!/at .*\.js/.test(r.text), "no stack trace");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await call("GET", "/api/nothing-here", { origin: null });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "not_found");
  });
});

describe("business profile and dashboard", () => {
  it("requires login for everything private", async () => {
    for (const [method, path] of [
      ["GET", "/api/dashboard"], ["GET", "/api/business"], ["PATCH", "/api/business"],
      ["PATCH", "/api/account"], ["POST", "/api/account/password"], ["DELETE", "/api/account/sessions"],
    ]) {
      const res = await call(method, path, { body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("returns dashboard data with progress and next actions", async () => {
    const { cookie } = await signUp();
    const res = await call("GET", "/api/dashboard", { cookie, origin: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.insights.progress.total, 26);
    assert.equal(res.json.insights.progress.completed, 15, "the 15 required fields are filled at sign-up");
    const ids = res.json.insights.nextActions.map((a) => a.id);
    for (const id of ["cac", "tin", "bank", "funding", "branches", "digital"]) assert.ok(ids.includes(id), id);
  });

  it("updates the profile and the next actions shrink as details are added", async () => {
    const { cookie } = await signUp();
    const before = await call("GET", "/api/dashboard", { cookie, origin: null });
    const res = await call("PATCH", "/api/business", {
      cookie,
      body: { cacNumber: "RC1234567", tin: "12345678-0001", bankName: "Example Bank", branches: "2", website: "obifabrics.com", fundingNeeds: "1 to 5 million naira" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.business.cacNumber, "RC1234567");
    assert.equal(res.json.business.branches, 2);
    assert.ok(res.json.insights.progress.completed > before.json.insights.progress.completed);
    assert.deepEqual(res.json.insights.nextActions, []);
  });

  it("a partial update changes only the fields that were sent", async () => {
    const { cookie } = await signUp({ business: { tradingName: "Obi Trading", bankName: "Example Bank", website: "obifabrics.com", fundingNeeds: "1 to 5 million naira" } });
    const res = await call("PATCH", "/api/business", { cookie, body: { cacNumber: "RC1234567" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.business.cacNumber, "RC1234567");
    assert.equal(res.json.business.tradingName, "Obi Trading");
    assert.equal(res.json.business.bankName, "Example Bank");
    assert.equal(res.json.business.website, "obifabrics.com");
    assert.equal(res.json.business.fundingNeeds, "1 to 5 million naira");
  });

  it("will not let the owner change verification status, ID, owner or unknown fields", async () => {
    const { cookie } = await signUp();
    for (const body of [
      { verificationStatus: "Verified" }, { nmrepId: "NMREP-1" }, { owner: "000000000000000000000000" },
      { verificationHistory: [] }, { isAdmin: true },
    ]) {
      const res = await call("PATCH", "/api/business", { cookie, body });
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    const dash = await call("GET", "/api/dashboard", { cookie, origin: null });
    assert.equal(dash.json.business.verificationStatus, "Unverified");
  });

  it("validates updates and will not blank required fields", async () => {
    const { cookie } = await signUp();
    assert.equal((await call("PATCH", "/api/business", { cookie, body: { businessName: "" } })).status, 422);
    assert.equal((await call("PATCH", "/api/business", { cookie, body: { state: "Atlantis" } })).status, 422);
    assert.equal((await call("PATCH", "/api/business", { cookie, body: {} })).status, 422);
    const cleared = await call("PATCH", "/api/business", { cookie, body: { tradingName: "Obi" } });
    assert.equal(cleared.json.business.tradingName, "Obi");
    const empty = await call("PATCH", "/api/business", { cookie, body: { tradingName: "" } });
    assert.equal(empty.json.business.tradingName, "");
  });

  it("keeps each user's business separate", async () => {
    const a = await signUp({ business: { businessName: "Alpha Foods" } });
    const b = await signUp({ business: { businessName: "Beta Farms" } });
    const da = await call("GET", "/api/dashboard", { cookie: a.cookie, origin: null });
    const db = await call("GET", "/api/dashboard", { cookie: b.cookie, origin: null });
    assert.equal(da.json.business.businessName, "Alpha Foods");
    assert.equal(db.json.business.businessName, "Beta Farms");
    await call("PATCH", "/api/business", { cookie: a.cookie, body: { industry: "Changed by A" } });
    const db2 = await call("GET", "/api/dashboard", { cookie: b.cookie, origin: null });
    assert.notEqual(db2.json.business.industry, "Changed by A");
  });
});

describe("account", () => {
  it("updates name and phone, validating them", async () => {
    const { cookie } = await signUp();
    const ok = await call("PATCH", "/api/account", { cookie, body: { fullName: "Ada Nwosu", phone: "08012345678" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.fullName, "Ada Nwosu");
    assert.equal((await call("PATCH", "/api/account", { cookie, body: { phone: "x" } })).status, 422);
    assert.equal((await call("PATCH", "/api/account", { cookie, body: { email: "new@example.com" } })).status, 422, "email cannot be changed here");
  });

  it("changes the password, signs out other devices and keeps this one", async () => {
    const { body, cookie } = await signUp();
    const second = await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Secret123" } });

    const wrong = await call("POST", "/api/account/password", { cookie, body: { currentPassword: "Nope12345", newPassword: "Brand3New99" } });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.json.error.fields.currentPassword);
    assert.equal((await call("POST", "/api/account/password", { cookie, body: { currentPassword: "Secret123", newPassword: "weak" } })).status, 422);

    const ok = await call("POST", "/api/account/password", { cookie, body: { currentPassword: "Secret123", newPassword: "Brand3New99" } });
    assert.equal(ok.status, 200);

    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 200, "this device stays signed in");
    assert.equal((await call("GET", "/api/auth/me", { cookie: second.cookie, origin: null })).status, 401, "other device signed out");
    assert.equal((await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Secret123" } })).status, 401);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Brand3New99" } })).status, 200);
  });

  it("logs out of all devices", async () => {
    const { body, cookie } = await signUp();
    const second = await call("POST", "/api/auth/login", { body: { email: body.account.email, password: "Secret123" } });
    assert.equal((await call("DELETE", "/api/account/sessions", { cookie: second.cookie })).status, 204);
    assert.equal((await call("GET", "/api/auth/me", { cookie, origin: null })).status, 401);
    assert.equal((await call("GET", "/api/auth/me", { cookie: second.cookie, origin: null })).status, 401);
  });
});

describe("rate limiting", () => {
  it("returns 429 after too many login attempts from one address", async () => {
    const limited = await startExtraApp({ RATE_LIMIT_LOGIN: "3" });
    try {
      const c = client(limited.base);
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await c("POST", "/api/auth/login", { body: { email: "x@example.com", password: "Wrong1234" } })).status);
      }
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.deepEqual(statuses.slice(3), [429, 429]);
    } finally {
      await limited.stop();
    }
  });
});

describe("indexes", () => {
  it("has a unique email index and a session expiry index", async () => {
    const userIdx = await mongoose.connection.collection("users").indexes();
    assert.ok(userIdx.some((i) => i.key.email === 1 && i.unique));
    const sessIdx = await mongoose.connection.collection("sessions").indexes();
    assert.ok(sessIdx.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
  });
});
