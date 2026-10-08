import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Agent } from "../src/models/Agent.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Business } from "../src/models/Business.js";
import { Session } from "../src/models/Session.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let superCookie;
let adminCookie;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const sup = await createStaff({ role: "super_admin" });
  const adm = await createStaff({ role: "admin" });
  superCookie = (await logIn(call, sup.email, sup.password)).cookie;
  adminCookie = (await logIn(call, adm.email, adm.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

const asSuper = (method, path, body) => call(method, path, { cookie: superCookie, body, origin: method === "GET" ? null : undefined });
const asAdmin = (method, path, body) => call(method, path, { cookie: adminCookie, body, origin: method === "GET" ? null : undefined });

async function newAgent(extra = {}) {
  const res = await asAdmin("POST", "/api/admin/agents", { fullName: "Chidi Okafor", phone: "08012345678", ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.agent;
}

async function registerOwner(overrides = {}) {
  const body = registrationBody(overrides);
  const res = await call("POST", "/api/auth/register", { body });
  return { body, res, cookie: res.cookie };
}

describe("referral codes", () => {
  it("generates a code in the NMR-XXXXXX format that avoids look-alike characters", async () => {
    const agent = await newAgent();
    assert.match(agent.code, /^NMR-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    assert.equal(agent.active, true);
    assert.equal(agent.registrants, 0);
  });

  it("generates a different code every time", async () => {
    const codes = new Set();
    for (let i = 0; i < 8; i += 1) codes.add((await newAgent({ fullName: `Agent ${i}` })).code);
    assert.equal(codes.size, 8);
  });

  it("attributes a registration to the agent, however the code is typed, and counts it", async () => {
    const agent = await newAgent();
    const typed = agent.code.toLowerCase().replace("-", " ");
    const { res } = await registerOwner({ top: { referralCode: typed } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const stored = await Business.findById(res.json.business.id);
    assert.equal(String(stored.referral.agent), agent.id);
    assert.equal(stored.referral.code, agent.code);

    await registerOwner({ top: { referralCode: agent.code } });
    const list = await asAdmin("GET", "/api/admin/agents");
    assert.equal(list.json.agents.find((a) => a.id === agent.id).registrants, 2);
  });

  it("never shows the owner who referred them", async () => {
    const agent = await newAgent();
    const { res, cookie } = await registerOwner({ top: { referralCode: agent.code } });
    assert.ok(!JSON.stringify(res.json).includes(agent.code));
    const dash = await call("GET", "/api/dashboard", { cookie, origin: null });
    assert.ok(!JSON.stringify(dash.json).includes(agent.code));
    assert.equal(dash.json.business.referral, undefined);
  });

  it("registers fine without a code", async () => {
    const { res } = await registerOwner();
    assert.equal(res.status, 201);
    const stored = await Business.findById(res.json.business.id);
    assert.equal(stored.referral.agent, null);
  });

  it("rejects an unknown code without creating an account", async () => {
    const before = await User.countDocuments();
    const { res } = await registerOwner({ top: { referralCode: "NMR-ZZZZZZ" } });
    assert.equal(res.status, 422);
    assert.ok(res.json.error.fields.referralCode);
    assert.equal(await User.countDocuments(), before);
  });

  it("rejects a malformed code", async () => {
    const { res } = await registerOwner({ top: { referralCode: "hello there!" } });
    assert.equal(res.status, 422);
    assert.ok(res.json.error.fields.referralCode);
  });

  it("rejects a deactivated code and accepts it again once reactivated, keeping earlier attributions", async () => {
    const agent = await newAgent();
    const first = await registerOwner({ top: { referralCode: agent.code } });
    assert.equal(first.res.status, 201);

    const off = await asAdmin("PATCH", `/api/admin/agents/${agent.id}`, { active: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.agent.active, false);
    const blocked = await registerOwner({ top: { referralCode: agent.code } });
    assert.equal(blocked.res.status, 422);
    assert.equal(blocked.res.json.error.fields.referralCode, "This referral code is not valid.", "same message as an unknown code");

    const detail = await asAdmin("GET", `/api/admin/agents/${agent.id}`);
    assert.equal(detail.json.registrants.length, 1, "the earlier registrant stays attributed");

    await asAdmin("PATCH", `/api/admin/agents/${agent.id}`, { active: true });
    assert.equal((await registerOwner({ top: { referralCode: agent.code } })).res.status, 201);
  });

  it("lists who an agent brought in", async () => {
    const agent = await newAgent();
    await registerOwner({ business: { businessName: "Referred Foods" }, top: { referralCode: agent.code } });
    const detail = await asAdmin("GET", `/api/admin/agents/${agent.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.agent.registrants, 1);
    assert.equal(detail.json.registrants[0].businessName, "Referred Foods");
    assert.ok(!JSON.stringify(detail.json).includes("passwordHash"));
  });

  it("lets an owner neither set nor change the referral", async () => {
    const { cookie } = await registerOwner();
    for (const body of [{ referral: { code: "NMR-AAAAAA" } }, { "referral.code": "NMR-AAAAAA" }, { referralCode: "NMR-AAAAAA" }]) {
      assert.equal((await call("PATCH", "/api/business", { cookie, body })).status, 422);
    }
  });

  it("validates agent details and rejects fields a client must not set", async () => {
    assert.equal((await asAdmin("POST", "/api/admin/agents", { fullName: "", phone: "x" })).status, 422);
    assert.equal((await asAdmin("POST", "/api/admin/agents", { fullName: "A B", phone: "08012345678", code: "NMR-HACKED" })).status, 422);
    assert.equal((await asAdmin("POST", "/api/admin/agents", { fullName: "A B", phone: "08012345678", active: false })).status, 422);
    const agent = await newAgent();
    assert.equal((await asAdmin("PATCH", `/api/admin/agents/${agent.id}`, { code: "NMR-HACKED" })).status, 422);
    assert.equal((await asAdmin("PATCH", `/api/admin/agents/${agent.id}`, {})).status, 422);
    assert.equal((await asAdmin("GET", "/api/admin/agents/not-an-id")).status, 404);
  });
});

describe("admin access control", () => {
  it("keeps owners and logged-out visitors out of the admin API", async () => {
    const { cookie } = await registerOwner();
    for (const path of ["/api/admin/overview", "/api/admin/businesses", "/api/admin/agents", "/api/admin/admins", "/api/admin/audit"]) {
      assert.equal((await call("GET", path, { cookie, origin: null })).status, 403, `owner ${path}`);
      assert.equal((await call("GET", path, { origin: null })).status, 401, `anonymous ${path}`);
    }
    assert.equal((await call("POST", "/api/admin/agents", { cookie, body: { fullName: "X Y", phone: "08012345678" } })).status, 403);
  });

  it("keeps admins out of the owner dashboard and business routes", async () => {
    assert.equal((await asAdmin("GET", "/api/dashboard")).status, 403);
    assert.equal((await asAdmin("GET", "/api/business")).status, 403);
    assert.equal((await asAdmin("PATCH", "/api/business", { city: "Lagos" })).status, 403);
  });

  it("lets a plain admin do everyday work but not manage admins or read the activity log", async () => {
    assert.equal((await asAdmin("GET", "/api/admin/overview")).status, 200);
    assert.equal((await asAdmin("GET", "/api/admin/admins")).status, 403);
    assert.equal((await asAdmin("POST", "/api/admin/admins", { fullName: "New Admin", email: "n@example.com", phone: "08012345678" })).status, 403);
    assert.equal((await asAdmin("GET", "/api/admin/audit")).status, 403);
    assert.equal((await asSuper("GET", "/api/admin/admins")).status, 200);
    assert.equal((await asSuper("GET", "/api/admin/audit")).status, 200);
  });

  it("checks the Origin on state-changing admin requests", async () => {
    const res = await call("POST", "/api/admin/agents", { cookie: adminCookie, origin: "https://evil.example", body: { fullName: "A B", phone: "08012345678" } });
    assert.equal(res.status, 403);
  });

  it("makes a new admin replace the temporary password before anything else", async () => {
    const temp = await createStaff({ role: "admin", password: "Temp-0000-aaaa", mustChangePassword: true });
    const login = await logIn(call, temp.email, temp.password);
    assert.equal(login.status, 200);
    assert.equal(login.json.user.mustChangePassword, true);

    const blocked = await call("GET", "/api/admin/overview", { cookie: login.cookie, origin: null });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "password_change_required");

    const same = await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: temp.password, newPassword: temp.password } });
    assert.equal(same.status, 422);

    const change = await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: temp.password, newPassword: "MyOwn-Pass-77" } });
    assert.equal(change.status, 200);
    assert.equal(change.json.user.mustChangePassword, false);
    assert.equal((await call("GET", "/api/admin/overview", { cookie: login.cookie, origin: null })).status, 200);
  });

  it("does not let a deactivated account log in, with the same message as a wrong password", async () => {
    const off = await createStaff({ role: "admin", active: false });
    const res = await logIn(call, off.email, off.password);
    const wrong = await logIn(call, off.email, "Wrong-pass-1");
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, wrong.json);
    assert.equal(res.cookie, null);
  });
});

describe("business review", () => {
  it("lists businesses with the owner's email, newest first, with a total", async () => {
    await registerOwner({ business: { businessName: "Alpha Textiles", state: "Lagos", sector: "Fashion and textiles" } });
    await registerOwner({ business: { businessName: "Beta Farms", state: "Oyo", sector: "Agriculture and agro-processing" } });
    const res = await asAdmin("GET", "/api/admin/businesses");
    assert.equal(res.status, 200);
    assert.ok(res.json.total >= 2);
    assert.equal(res.json.pageSize, 20);
    assert.ok(res.json.items.length >= 2);
    const first = res.json.items[0];
    for (const key of ["id", "businessName", "ownerName", "email", "state", "sector", "verificationStatus", "createdAt"]) assert.ok(key in first, key);
    assert.ok(!JSON.stringify(res.json).includes("passwordHash"));
    const dates = res.json.items.map((i) => new Date(i.createdAt).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  });

  it("searches and filters", async () => {
    await registerOwner({ business: { businessName: "Searchable Soaps Ltd", state: "Kano" } });
    const byName = await asAdmin("GET", "/api/admin/businesses?q=searchable%20soaps");
    assert.equal(byName.json.items.length, 1);
    assert.equal(byName.json.items[0].businessName, "Searchable Soaps Ltd");

    const byState = await asAdmin("GET", "/api/admin/businesses?state=Kano");
    assert.ok(byState.json.items.every((i) => i.state === "Kano"));
    assert.ok(byState.json.items.length >= 1);

    const none = await asAdmin("GET", "/api/admin/businesses?q=no-such-business-anywhere");
    assert.equal(none.json.total, 0);

    assert.equal((await asAdmin("GET", "/api/admin/businesses?status=Verified&sector=Manufacturing")).status, 200);
  });

  it("treats search text as plain text, not as a pattern or a query", async () => {
    for (const q of ["(", ".*", "[a-", "a|b", "\\", "{$ne:1}"]) {
      const res = await asAdmin("GET", `/api/admin/businesses?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `q=${q}`);
    }
    const wild = await asAdmin("GET", `/api/admin/businesses?q=${encodeURIComponent(".*")}`);
    assert.equal(wild.json.total, 0, "a regular expression is not interpreted");
  });

  it("rejects bad query values and unknown parameters", async () => {
    assert.equal((await asAdmin("GET", "/api/admin/businesses?status=Hacked")).status, 422);
    assert.equal((await asAdmin("GET", "/api/admin/businesses?page=0")).status, 422);
    assert.equal((await asAdmin("GET", "/api/admin/businesses?agent=zzz")).status, 422);
    assert.equal((await asAdmin("GET", "/api/admin/businesses?evil=1")).status, 422);
  });

  it("paginates", async () => {
    const res = await asAdmin("GET", "/api/admin/businesses?page=999");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal(res.json.page, 999);
  });

  it("filters by the agent who referred them", async () => {
    const agent = await newAgent({ fullName: "Filter Agent" });
    await registerOwner({ business: { businessName: "Via Agent Ltd" }, top: { referralCode: agent.code } });
    const res = await asAdmin("GET", `/api/admin/businesses?agent=${agent.id}`);
    assert.equal(res.json.total, 1);
    assert.equal(res.json.items[0].referralCode, agent.code);
  });

  it("shows a business with its owner and referral", async () => {
    const agent = await newAgent({ fullName: "Detail Agent" });
    const { res } = await registerOwner({ top: { referralCode: agent.code } });
    const detail = await asAdmin("GET", `/api/admin/businesses/${res.json.business.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.business.businessName, "Obi Fabrics");
    assert.equal(detail.json.owner.email, res.json.user.email);
    assert.deepEqual(detail.json.referral, { code: agent.code, agentId: agent.id, agentName: "Detail Agent" });
    assert.ok(!JSON.stringify(detail.json).includes("passwordHash"));
    assert.equal((await asAdmin("GET", "/api/admin/businesses/000000000000000000000000")).status, 404);
    assert.equal((await asAdmin("GET", "/api/admin/businesses/%24ne")).status, 404);
  });

  it("changes verification status, shows it to the owner, and issues the NMREP ID once", async () => {
    const a = await registerOwner({ business: { businessName: "Verify Me A" } });
    const b = await registerOwner({ business: { businessName: "Verify Me B" } });
    const idA = a.res.json.business.id;

    assert.equal((await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Verified" })).status, 422, "a note is required");
    assert.equal((await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Approved", note: "x" })).status, 422);
    assert.equal((await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Unverified", note: "same" })).status, 422, "already has this status");
    assert.equal((await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Verified", note: "x", nmrepId: "NMREP-0-0" })).status, 422);

    const pending = await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Pending Verification", note: "Documents received" });
    assert.equal(pending.status, 200);
    assert.equal(pending.json.business.nmrepId, null, "no ID before verification");

    const verified = await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Verified", note: "Checks complete" });
    assert.equal(verified.status, 200);
    const idValue = verified.json.business.nmrepId;
    assert.match(idValue, /^NMREP-\d{4}-\d{6}$/);

    // The owner sees exactly this on their own dashboard.
    const dash = await call("GET", "/api/dashboard", { cookie: a.cookie, origin: null });
    assert.equal(dash.json.business.verificationStatus, "Verified");
    assert.equal(dash.json.business.nmrepId, idValue);
    const history = dash.json.business.verificationHistory;
    assert.deepEqual(history.map((h) => h.status), ["Unverified", "Pending Verification", "Verified"]);
    assert.equal(history[2].note, "Checks complete");

    // The next verified business gets the next number, and a suspension keeps the ID.
    const second = await asAdmin("POST", `/api/admin/businesses/${b.res.json.business.id}/status`, { status: "Verified", note: "OK" });
    const idB = second.json.business.nmrepId;
    assert.match(idB, /^NMREP-\d{4}-\d{6}$/);
    assert.equal(Number(idB.slice(-6)), Number(idValue.slice(-6)) + 1);
    const suspended = await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Suspended", note: "Under review" });
    assert.equal(suspended.json.business.nmrepId, idValue);
    const again = await asAdmin("POST", `/api/admin/businesses/${idA}/status`, { status: "Verified", note: "Cleared" });
    assert.equal(again.json.business.nmrepId, idValue, "the same ID is kept");
  });

  it("never issues the same NMREP ID twice, even when several are verified at once", async () => {
    const owners = [];
    for (let i = 0; i < 5; i += 1) owners.push(await registerOwner({ business: { businessName: `Parallel ${i}` } }));
    const results = await Promise.all(
      owners.map((o) => asAdmin("POST", `/api/admin/businesses/${o.res.json.business.id}/status`, { status: "Verified", note: "Batch" })),
    );
    const ids = results.map((r) => r.json.business.nmrepId);
    assert.ok(ids.every((x) => /^NMREP-\d{4}-\d{6}$/.test(x)));
    assert.equal(new Set(ids).size, 5);
  });

  it("counts everything on the overview", async () => {
    const agent = await newAgent({ fullName: "Top Agent" });
    await registerOwner({ top: { referralCode: agent.code } });
    const res = await asAdmin("GET", "/api/admin/overview");
    assert.equal(res.status, 200);
    const t = res.json.totals;
    assert.equal(t.businesses, Object.values(t.byStatus).reduce((a, b) => a + b, 0));
    assert.ok(t.last7Days >= 1 && t.last30Days >= t.last7Days);
    assert.ok(t.referred >= 1 && t.activeAgents >= 1);
    assert.ok(res.json.topReferrers.length >= 1);
    assert.equal(typeof res.json.topReferrers[0].count, "number");
    assert.ok(res.json.recent.length >= 1);
  });
});

describe("admin management (super admin)", () => {
  it("creates an admin with a one-time temporary password and never stores or lists it", async () => {
    const res = await asSuper("POST", "/api/admin/admins", { fullName: "Grace Admin", email: "Grace.Admin@Example.com", phone: "08012345678" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.match(res.json.temporaryPassword, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
    assert.equal(res.json.admin.role, "admin");
    assert.equal(res.json.admin.email, "grace.admin@example.com");
    assert.equal(res.json.admin.mustChangePassword, true);
    assert.ok(!JSON.stringify(res.json.admin).includes("passwordHash"));

    const stored = await User.findOne({ email: "grace.admin@example.com" }).select("+passwordHash");
    assert.ok(!stored.passwordHash.includes(res.json.temporaryPassword));
    assert.match(stored.passwordHash, /^\$2[aby]\$/);

    const list = await asSuper("GET", "/api/admin/admins");
    assert.ok(list.json.admins.some((a) => a.email === "grace.admin@example.com"));
    assert.ok(!JSON.stringify(list.json).includes(res.json.temporaryPassword));
    assert.ok(!JSON.stringify(list.json).includes("passwordHash"));
  });

  it("cannot be used to create a super admin or set other fields", async () => {
    const base = { fullName: "Sneaky", email: "sneaky@example.com", phone: "08012345678" };
    assert.equal((await asSuper("POST", "/api/admin/admins", { ...base, role: "super_admin" })).status, 422);
    assert.equal((await asSuper("POST", "/api/admin/admins", { ...base, mustChangePassword: false })).status, 422);
    assert.equal((await asSuper("POST", "/api/admin/admins", { ...base, password: "Mine12345" })).status, 422);
    assert.equal(await User.exists({ email: "sneaky@example.com" }), null);
  });

  it("rejects a duplicate email", async () => {
    const dup = { fullName: "Dup Admin", email: "dup.admin@example.com", phone: "08012345678" };
    assert.equal((await asSuper("POST", "/api/admin/admins", dup)).status, 201);
    assert.equal((await asSuper("POST", "/api/admin/admins", dup)).status, 409);
  });

  it("deactivates an admin at once: sessions end and login stops, then reactivation restores access", async () => {
    const created = await asSuper("POST", "/api/admin/admins", { fullName: "Temp Admin", email: "temp.admin@example.com", phone: "08012345678" });
    const { temporaryPassword: tmp } = created.json;
    const first = await logIn(call, "temp.admin@example.com", tmp);
    await call("POST", "/api/account/password", { cookie: first.cookie, body: { currentPassword: tmp, newPassword: "Chosen-Pass-55" } });
    assert.equal((await call("GET", "/api/admin/overview", { cookie: first.cookie, origin: null })).status, 200);

    const off = await asSuper("PATCH", `/api/admin/admins/${created.json.admin.id}`, { active: false });
    assert.equal(off.status, 200);
    assert.equal(await Session.countDocuments({ user: created.json.admin.id }), 0);
    assert.equal((await call("GET", "/api/admin/overview", { cookie: first.cookie, origin: null })).status, 401);
    assert.equal((await logIn(call, "temp.admin@example.com", "Chosen-Pass-55")).status, 401);

    await asSuper("PATCH", `/api/admin/admins/${created.json.admin.id}`, { active: true });
    assert.equal((await logIn(call, "temp.admin@example.com", "Chosen-Pass-55")).status, 200);
  });

  it("resets an admin's password to a new temporary one and signs them out", async () => {
    const created = await asSuper("POST", "/api/admin/admins", { fullName: "Reset Me", email: "reset.me@example.com", phone: "08012345678" });
    const live = await logIn(call, "reset.me@example.com", created.json.temporaryPassword);
    const reset = await asSuper("POST", `/api/admin/admins/${created.json.admin.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.notEqual(reset.json.temporaryPassword, created.json.temporaryPassword);
    assert.equal(reset.json.admin.mustChangePassword, true);
    assert.equal((await call("GET", "/api/auth/me", { cookie: live.cookie, origin: null })).status, 401);
    assert.equal((await logIn(call, "reset.me@example.com", created.json.temporaryPassword)).status, 401);
    assert.equal((await logIn(call, "reset.me@example.com", reset.json.temporaryPassword)).status, 200);
  });

  it("cannot change super admins or owners through the admin routes", async () => {
    const sup = await User.findOne({ role: "super_admin" });
    assert.equal((await asSuper("PATCH", `/api/admin/admins/${sup._id}`, { active: false })).status, 404);
    assert.equal((await asSuper("POST", `/api/admin/admins/${sup._id}/reset-password`)).status, 404);
    const { res } = await registerOwner();
    assert.equal((await asSuper("PATCH", `/api/admin/admins/${res.json.user.id}`, { active: false })).status, 404);
    assert.equal((await asSuper("PATCH", "/api/admin/admins/not-an-id", { active: false })).status, 404);
    assert.equal((await asSuper("PATCH", `/api/admin/admins/${sup._id}`, { role: "admin" })).status, 422);
  });

  it("records what admins do, without secrets", async () => {
    const res = await asSuper("GET", "/api/admin/audit");
    assert.equal(res.status, 200);
    assert.ok(res.json.total > 5);
    const actions = new Set(res.json.items.map((i) => i.action));
    for (const a of ["agent.create", "business.status", "admin.create"]) assert.ok(actions.has(a) || res.json.total > 30, a);
    const text = JSON.stringify(res.json);
    assert.ok(!/passwordHash|temporaryPassword|Chosen-Pass|\$2[aby]\$/.test(text));
    const all = JSON.stringify(await AuditLog.find({}).lean());
    assert.ok(!/passwordHash|Chosen-Pass|Secret123/.test(all));
    assert.ok(res.json.items[0].actorName.includes("super admin") || res.json.items[0].actorName.includes("admin"));
    assert.equal((await asSuper("GET", "/api/admin/audit?page=0")).status, 422);
  });

  it("indexes referral lookups", async () => {
    const idx = await Agent.collection.indexes();
    assert.ok(idx.some((i) => i.key.code === 1 && i.unique));
    const bidx = await Business.collection.indexes();
    assert.ok(bidx.some((i) => i.key["referral.agent"] === 1));
  });
});
