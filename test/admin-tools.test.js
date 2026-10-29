import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runDeadlineReminders, runSessionReminders } from "../src/lib/reminders.js";
import { Application } from "../src/models/Application.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Opportunity } from "../src/models/Opportunity.js";
import { TrainingRecord } from "../src/models/TrainingRecord.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let admin;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

let n = 0;
async function owner(business = {}) {
  n += 1;
  const body = registrationBody({ account: { email: `tools${n}-${Date.now()}@example.com` }, business });
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, businessId: res.json.business.id, userId: res.json.user.id, email: body.account.email };
}

async function makeOpportunity(extra = {}, status = "Open") {
  const res = await call("POST", "/api/admin/opportunities", {
    cookie: admin,
    body: { title: "Tools programme", provider: "Example Foundation", type: "Grant", description: "A programme.", ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  if (status !== "Draft") assert.equal((await call("PATCH", `/api/admin/opportunities/${res.json.opportunity.id}`, { cookie: admin, body: { status } })).status, 200);
  return res.json.opportunity.id;
}

const notifications = async (o) => (await call("GET", "/api/notifications", { cookie: o.cookie, origin: null })).json.items;

describe("revoking and restoring an owner account", () => {
  it("blocks sign-in and ends every session, then lets the owner back in, all recorded", async () => {
    const o = await owner();
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie, origin: null })).status, 200);

    const noReason = await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: admin, body: { active: false } });
    assert.equal(noReason.status, 422);
    assert.ok(noReason.json.error.fields.reason);

    const revoked = await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: admin, body: { active: false, reason: "Fake registration" } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.owner.active, false);
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie, origin: null })).status, 401, "the open session is gone");
    assert.equal((await call("POST", "/api/auth/login", { body: { email: o.email, password: "Secret123" } })).status, 401);

    const detail = await call("GET", `/api/admin/businesses/${o.businessId}`, { cookie: admin, origin: null });
    assert.equal(detail.json.owner.active, false);
    const list = await call("GET", `/api/admin/businesses?q=${encodeURIComponent(o.email)}`, { cookie: admin, origin: null });
    assert.equal(list.json.items.find((b) => b.id === o.businessId).accountActive, false);

    assert.equal((await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: admin, body: { active: false, reason: "again" } })).status, 422, "already revoked");
    assert.equal((await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: admin, body: { active: true } })).status, 200);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: o.email, password: "Secret123" } })).status, 200);

    const revokedRow = await AuditLog.findOne({ action: "owner.revoke", summary: /Fake registration/ });
    assert.ok(revokedRow);
    assert.ok(await AuditLog.findOne({ action: "owner.restore" }));
  });

  it("only administrators can do it", async () => {
    const o = await owner();
    const res = await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: o.cookie, body: { active: false, reason: "x" } });
    assert.equal(res.status, 403);
    assert.equal((await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { body: { active: false, reason: "x" } })).status, 401);
  });
});

describe("broadcasts", () => {
  it("counts the audience first, then sends an in-app message to the owners in it, and never to a revoked account", async () => {
    const kano = await owner({ state: "Kano", sector: "Manufacturing" });
    const kano2 = await owner({ state: "Kano", sector: "Manufacturing" });
    const lagos = await owner({ state: "Lagos", sector: "Manufacturing" });
    await call("PATCH", `/api/admin/businesses/${kano2.businessId}/account`, { cookie: admin, body: { active: false, reason: "test" } });

    const preview = await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "Hello Kano", audience: { states: ["Kano"] }, preview: true } });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.recipients, 1, "the revoked account is not counted");

    const sent = await call("POST", "/api/admin/broadcasts", {
      cookie: admin,
      body: { title: "Workshop in Kano", body: "Free workshop on Friday.", link: "/dashboard/training/", audience: { states: ["Kano"], sectors: ["Manufacturing"] } },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(sent.json.broadcast.recipients, 1);

    const got = (await notifications(kano)).find((x) => x.title === "Workshop in Kano");
    assert.ok(got);
    assert.equal(got.type, "announcement");
    assert.equal(got.link, "/dashboard/training/");
    assert.equal(got.broadcast, undefined, "internal ids are not shown to owners");
    assert.ok(!(await notifications(lagos)).some((x) => x.title === "Workshop in Kano"));

    // The list shows how many have read it.
    await call("POST", "/api/notifications/read", { cookie: kano.cookie, body: {} });
    const list = await call("GET", "/api/admin/broadcasts", { cookie: admin, origin: null });
    const row = list.json.items.find((b) => b.title === "Workshop in Kano");
    assert.equal(row.recipients, 1);
    assert.equal(row.read, 1);
  });

  it("refuses an empty audience, a link outside the dashboard, an unknown state and an owner", async () => {
    const none = await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "Nobody", audience: { states: ["Kano"], sectors: ["Other"], verificationStatuses: ["Suspended"] } } });
    assert.equal(none.status, 422);
    assert.equal(none.json.error.code, "no_recipients");
    assert.equal((await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "x", link: "https://evil.example" } })).status, 422);
    assert.equal((await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "x", audience: { states: ["Narnia"] } } })).status, 422);
    const o = await owner();
    assert.equal((await call("POST", "/api/admin/broadcasts", { cookie: o.cookie, body: { title: "x" } })).status, 403);
  });
});

describe("which businesses meet an opportunity", () => {
  it("scores every active business, filters by label, pages, and exports without contact details", async () => {
    const fits = await owner({ state: "Ogun", sector: "Manufacturing" });
    const near = await owner({ state: "Ogun", sector: "Retail and trading" });
    const far = await owner({ state: "Kwara", sector: "Retail and trading" });
    const revoked = await owner({ state: "Ogun", sector: "Manufacturing" });
    await call("PATCH", `/api/admin/businesses/${revoked.businessId}/account`, { cookie: admin, body: { active: false, reason: "test" } });

    const id = await makeOpportunity({
      title: "Ogun manufacturers",
      criteria: [
        { key: "state", level: "required", values: ["Ogun"] },
        { key: "sector", level: "required", values: ["Manufacturing"] },
        { key: "verified", level: "required" },
        { key: "hasTin", level: "required" },
      ],
    });
    // "fits" would meet state and sector only: verified and TIN are missing, so make a simpler one for an exact check.
    const simple = await makeOpportunity({ title: "Ogun only", criteria: [{ key: "state", level: "required", values: ["Ogun"] }] });

    const res = await call("GET", `/api/admin/opportunities/${simple}/matches`, { cookie: admin, origin: null });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const names = res.json.items.map((i) => i.businessId);
    assert.ok(names.includes(fits.businessId) && names.includes(near.businessId));
    assert.ok(!names.includes(revoked.businessId), "a revoked account is left out");
    const byId = Object.fromEntries(res.json.items.map((i) => [i.businessId, i]));
    assert.equal(byId[fits.businessId].fit.label, "Eligible");
    assert.equal(byId[far.businessId].fit.label, "Nearly eligible", "one required requirement missing");
    assert.ok(res.json.counts.Eligible >= 2);
    assert.equal(res.json.total, res.json.items.length <= 20 ? res.json.items.length : res.json.total);

    const eligibleOnly = await call("GET", `/api/admin/opportunities/${simple}/matches?label=Eligible`, { cookie: admin, origin: null });
    assert.ok(eligibleOnly.json.items.every((i) => i.fit.label === "Eligible"));
    assert.equal((await call("GET", `/api/admin/opportunities/${simple}/matches?label=Maybe`, { cookie: admin, origin: null })).status, 422);

    const hard = await call("GET", `/api/admin/opportunities/${id}/matches?label=Not%20eligible`, { cookie: admin, origin: null });
    assert.equal(hard.status, 200);

    const csv = await fetch(`${ctx.base}/api/admin/opportunities/${simple}/matches.csv?label=Eligible`, { headers: { Cookie: admin, Origin: "http://localhost:3000" } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    const text = await csv.text();
    assert.ok(text.includes("Obi Fabrics"));
    assert.ok(!text.includes("@"), "no email addresses in the matches file");
    assert.equal((await call("GET", `/api/admin/opportunities/${"a".repeat(24)}/matches`, { cookie: admin, origin: null })).status, 404);
  });
});

describe("archiving and deleting opportunities", () => {
  it("an open one must be closed first; an archived one leaves the live list and can come back", async () => {
    const id = await makeOpportunity({ title: "Old programme" });
    assert.equal((await call("POST", `/api/admin/opportunities/${id}/archive`, { cookie: admin })).status, 409);
    assert.equal((await call("DELETE", `/api/admin/opportunities/${id}`, { cookie: admin })).status, 409);
    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Closed" } });

    const archived = await call("POST", `/api/admin/opportunities/${id}/archive`, { cookie: admin });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    assert.ok(archived.json.opportunity.archivedAt);

    const live = await call("GET", "/api/admin/opportunities", { cookie: admin, origin: null });
    assert.ok(!live.json.items.some((o) => o.id === id));
    const arch = await call("GET", "/api/admin/opportunities?archived=true", { cookie: admin, origin: null });
    assert.ok(arch.json.items.some((o) => o.id === id));
    assert.ok(arch.json.items.every((o) => o.archivedAt));

    assert.equal((await call("POST", `/api/admin/opportunities/${id}/unarchive`, { cookie: admin })).status, 200);
    assert.ok((await call("GET", "/api/admin/opportunities", { cookie: admin, origin: null })).json.items.some((o) => o.id === id));
  });

  it("deleting works only when nobody has applied; otherwise it must be archived", async () => {
    const o = await owner();
    const used = await makeOpportunity({ title: "Has an applicant" });
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: used, message: "hi" } })).status, 201);
    await call("PATCH", `/api/admin/opportunities/${used}`, { cookie: admin, body: { status: "Closed" } });
    const refused = await call("DELETE", `/api/admin/opportunities/${used}`, { cookie: admin });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "has_applications");

    const unused = await makeOpportunity({ title: "Never used" }, "Draft");
    assert.equal((await call("DELETE", `/api/admin/opportunities/${unused}`, { cookie: admin })).status, 204);
    assert.equal(await Opportunity.countDocuments({ title: "Never used" }), 0);
    assert.equal((await call("DELETE", `/api/admin/opportunities/${unused}`, { cookie: admin })).status, 404);
    assert.equal((await call("DELETE", `/api/admin/opportunities/${used}`, { cookie: o.cookie })).status, 403);
  });
});

describe("reminders", () => {
  const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);

  it("tells eligible owners who have not applied that a programme is closing, once, and again a day before", async () => {
    const eligible = await owner({ state: "Edo" });
    const drafter = await owner({ state: "Edo" });
    const applied = await owner({ state: "Edo" });
    const ineligible = await owner({ state: "Lagos" });
    const id = await makeOpportunity({ title: "Closing soon", criteria: [{ key: "state", level: "required", values: ["Edo"] }] });
    await call("POST", "/api/applications", { cookie: drafter.cookie, body: { opportunityId: id, message: "draft" } });
    await call("POST", "/api/applications", { cookie: applied.cookie, body: { opportunityId: id, message: "sent", submit: true, consent: { summary: true } } });
    await Opportunity.updateOne({ _id: id }, { $set: { deadline: inDays(2.5) } });

    const first = await runDeadlineReminders(new Date());
    assert.ok(first >= 2);
    // The opening of the opportunity also sent a "New opportunity" notice, so only the reminders are counted.
    const has = async (o, title) => (await notifications(o)).filter((x) => x.title.includes(title) && /closes/.test(x.title));
    assert.equal((await has(eligible, "Closing soon")).length, 1);
    assert.match((await has(eligible, "Closing soon"))[0].title, /closes in 3 days/);
    assert.equal((await has(eligible, "Closing soon"))[0].link, `/dashboard/opportunities/detail/?id=${id}`);
    assert.match((await has(drafter, "Closing soon"))[0].body, /draft/);
    assert.equal((await has(applied, "Closing soon")).length, 0, "someone who already applied is left alone");
    assert.equal((await has(ineligible, "Closing soon")).length, 0, "someone who cannot apply is left alone");

    assert.equal(await runDeadlineReminders(new Date()), 0, "running again sends nothing twice");

    // A day before the end, a second reminder is sent.
    await Opportunity.updateOne({ _id: id }, { $set: { deadline: inDays(0.5) } });
    await runDeadlineReminders(new Date());
    const all = await has(eligible, "Closing soon");
    assert.equal(all.length, 2);
    assert.ok(all.some((x) => /closes tomorrow/.test(x.title)));
  });

  it("does not remind a revoked account, and leaves programmes that are not closing soon alone", async () => {
    const o = await owner({ state: "Osun" });
    await call("PATCH", `/api/admin/businesses/${o.businessId}/account`, { cookie: admin, body: { active: false, reason: "test" } });
    const far = await makeOpportunity({ title: "Far away", criteria: [{ key: "state", level: "required", values: ["Osun"] }] });
    await Opportunity.updateOne({ _id: far }, { $set: { deadline: inDays(20) } });
    const soon = await makeOpportunity({ title: "Soon but revoked", criteria: [{ key: "state", level: "required", values: ["Osun"] }] });
    await Opportunity.updateOne({ _id: soon }, { $set: { deadline: inDays(1.5) } });
    await runDeadlineReminders(new Date());
    const { Notification } = await import("../src/models/Notification.js");
    assert.equal(await Notification.countDocuments({ user: o.userId }), 0, "a revoked account hears nothing, not even that a programme opened");
  });

  it("tells registered participants the day before a training session, once", async () => {
    const o = await owner();
    const id = await makeOpportunity({ title: "Bookkeeping basics", type: "Training" });
    const tomorrow = inDays(0.5);
    await Opportunity.updateOne({ _id: id }, { $set: { training: { mode: "In person", venue: "Ikeja hall", sessions: [{ title: "Day one", on: tomorrow }] } } });
    const application = await Application.create({ opportunity: id, business: o.businessId, owner: o.userId, status: "Approved" });
    await TrainingRecord.create({ application: application._id, opportunity: id, business: o.businessId, owner: o.userId });

    assert.equal(await runSessionReminders(new Date()), 1);
    const got = (await notifications(o)).find((x) => x.title.includes("Bookkeeping basics"));
    assert.ok(got);
    assert.match(got.body, /Day one/);
    assert.match(got.body, /Ikeja hall/);
    assert.equal(got.link, "/dashboard/training/");
    assert.equal(await runSessionReminders(new Date()), 0, "once only");
  });
});
