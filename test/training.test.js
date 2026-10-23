import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Notification } from "../src/models/Notification.js";
import { TrainingRecord } from "../src/models/TrainingRecord.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The training ecosystem: plan, registration (an approved application), attendance, assessment, completion and
// the certificate, for a training provider, NMREP staff and the business owner.

let ctx;
let call;
let admin;
let counter = 0;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

async function owner(account = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ account }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, name: res.json.user.fullName, email: res.json.user.email, phone: res.json.user.phone, business: res.json.business.businessName };
}

/** A training provider organisation with one login that has replaced its temporary password. */
async function provider(type = "Training Provider") {
  counter += 1;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Provider ${counter} ${Date.now()}`, type } });
  assert.equal(org.status, 201, JSON.stringify(org.json));
  const email = `trainer${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, { cookie: admin, body: { fullName: "Tola Trainer", email, phone: "08011112222" } });
  const login = await logIn(call, email, created.json.temporaryPassword);
  await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "TrainerPass1" } });
  return { cookie: login.cookie, orgId: org.json.organisation.id };
}

/** An approved Training opportunity run by `p`, with a plan of two sessions. Returns its id and the session ids. */
async function openTraining(p, { plan = {}, title = "Bookkeeping basics" } = {}) {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { title, type: "Training", description: "Learn to keep simple books." } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const id = c.json.opportunity.id;
  assert.equal((await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie })).status, 200);
  assert.equal((await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin })).status, 200);
  const saved = await call("PUT", `/api/partner/training/${id}/plan`, {
    cookie: p.cookie,
    body: { mode: "Hybrid", venue: "12 Allen Avenue, Ikeja", startsOn: "2030-03-01", endsOn: "2030-03-08", sessions: [{ title: "Day 1", on: "2030-03-01" }, { title: "Day 2", on: "2030-03-08" }], minSessions: 1, requirePass: false, ...plan },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return { id, sessions: saved.json.opportunity.training.sessions.map((s) => s.id) };
}

/** An owner applies (sharing only the summary unless told otherwise) and the provider approves. */
async function register(o, p, trainingId, consent = { summary: true }) {
  const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: trainingId, message: "Please enrol us.", submit: true, consent } });
  assert.equal(app.status, 201, JSON.stringify(app.json));
  const applicationId = app.json.application.id;
  const ok = await call("POST", `/api/partner/applications/${applicationId}/status`, { cookie: p.cookie, body: { status: "Approved", note: "Welcome." } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return applicationId;
}

const training = (p, id, rest = "") => call("GET", `/api/partner/training/${id}${rest}`, { cookie: p.cookie });

describe("training providers and the plan", () => {
  it("lists only Training opportunities, shows the plan to owners, and keeps other opportunities out of the training routes", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const grant = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { title: "A grant", type: "Grant", description: "Not a training." } });

    const list = await call("GET", "/api/partner/training", { cookie: p.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map((i) => i.id), [t.id]);
    assert.equal(list.json.items[0].participants, 0);
    assert.equal((await training(p, grant.json.opportunity.id)).status, 404, "not a training");

    const o = await owner();
    const detail = await call("GET", `/api/opportunities/${t.id}`, { cookie: o.cookie });
    const plan = detail.json.opportunity.training;
    assert.equal(plan.mode, "Hybrid");
    assert.equal(plan.venue, "12 Allen Avenue, Ikeja");
    assert.deepEqual(plan.sessions.map((s) => s.title), ["Day 1", "Day 2"]);
    assert.ok(plan.sessions.every((s) => /^[0-9a-f]{24}$/.test(s.id)));
    assert.equal(plan.sessions[0].on, "2030-02-28T23:00:00.000Z", "start of the day in Nigeria");
  });

  it("validates the plan and refuses unknown fields", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const put = (body) => call("PUT", `/api/partner/training/${t.id}/plan`, { cookie: p.cookie, body });
    const ok = { mode: "Online", sessions: [{ title: "One", on: "2030-05-01" }], minSessions: 1 };
    assert.equal((await put(ok)).status, 200);
    assert.equal((await put({ ...ok, mode: "Telepathy" })).json.error.fields.mode, "Choose one of the listed options.");
    assert.ok((await put({ ...ok, startsOn: "2030-05-09", endsOn: "2030-05-01" })).json.error.fields.endsOn);
    assert.ok((await put({ ...ok, minSessions: 2 })).json.error.fields.minSessions);
    assert.ok((await put({ ...ok, sessions: [{ title: "", on: "2030-05-01" }] })).json.error.fields["sessions.0.title"]);
    assert.ok((await put({ ...ok, sessions: [{ title: "x", on: "tomorrow" }] })).json.error.fields["sessions.0.on"]);
    assert.ok((await put({ ...ok, sessions: Array.from({ length: 61 }, (_, i) => ({ title: `S${i}`, on: "2030-05-01" })) })).json.error.fields.sessions);
    assert.equal((await put({ ...ok, price: 5 })).status, 422, "unknown field");
    assert.equal((await put({ ...ok, sessions: [{ id: "a".repeat(24), title: "Ghost", on: "2030-05-01" }] })).status, 422, "an id that is not a session of this training");
  });

  it("keeps sessions by id, and refuses to remove a session that already has attendance", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    await register(o, p, t.id);
    const detail = await training(p, t.id);
    const applicationId = detail.json.participants[0].applicationId;
    assert.equal((await call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body: { sessionId: t.sessions[0], marks: [{ applicationId, present: true }] } })).status, 200);

    // Renaming and moving a session keeps its id, so its attendance stays.
    const keep = await call("PUT", `/api/partner/training/${t.id}/plan`, {
      cookie: p.cookie,
      body: { mode: "Hybrid", sessions: [{ id: t.sessions[0], title: "Day 1 (moved)", on: "2030-03-02" }, { id: t.sessions[1], title: "Day 2", on: "2030-03-08" }, { title: "Day 3", on: "2030-03-15" }], minSessions: 1 },
    });
    assert.equal(keep.status, 200);
    assert.equal(keep.json.opportunity.training.sessions.length, 3);
    const again = await training(p, t.id);
    assert.equal(again.json.participants[0].attendance[t.sessions[0]], true);

    const drop = await call("PUT", `/api/partner/training/${t.id}/plan`, { cookie: p.cookie, body: { mode: "Hybrid", sessions: [{ id: t.sessions[1], title: "Day 2", on: "2030-03-08" }], minSessions: 0 } });
    assert.equal(drop.status, 409);
    assert.equal(drop.json.error.code, "session_in_use");
    const free = await call("PUT", `/api/partner/training/${t.id}/plan`, { cookie: p.cookie, body: { mode: "Hybrid", sessions: [{ id: t.sessions[0], title: "Day 1", on: "2030-03-01" }], minSessions: 0 } });
    assert.equal(free.status, 200, "a session with no attendance can be removed");
  });
});

describe("attendance, assessment, completion and the certificate", () => {
  it("runs the whole flow from registration to a certificate anyone can check", async () => {
    const p = await provider();
    const t = await openTraining(p, { plan: { minSessions: 2, requirePass: true } });
    const o = await owner({ fullName: "Ada Obi" });
    const applicationId = await register(o, p, t.id, { summary: true, contact: true });

    // Registered: the owner sees the training with nothing recorded yet.
    let mine = await call("GET", "/api/training", { cookie: o.cookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.items.length, 1);
    assert.equal(mine.json.items[0].status, "Approved");
    assert.deepEqual(mine.json.items[0].sessions.map((s) => s.present), [null, null]);
    assert.equal(mine.json.items[0].certificate, null);

    const mark = (sessionId, present) => call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body: { sessionId, marks: [{ applicationId, present }] } });
    assert.equal((await mark(t.sessions[0], true)).status, 200);
    assert.equal((await mark(t.sessions[1], false)).status, 200);

    // Not ready: one session attended of two needed, and no assessment.
    const early = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} });
    assert.equal(early.status, 422);
    assert.equal(early.json.error.code, "not_ready");
    assert.match(early.json.error.message, /Attended 1 of the 2 sessions needed/);
    assert.match(early.json.error.message, /assessment has not been passed/);

    // Correcting a mark replaces it, and a failed assessment still blocks completion.
    assert.equal((await mark(t.sessions[1], true)).status, 200);
    const failed = await call("POST", `/api/partner/training/${t.id}/assessment`, { cookie: p.cookie, body: { applicationId, result: "Failed", score: 40, note: "Please try again." } });
    assert.equal(failed.status, 200);
    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} })).status, 422);

    const passed = await call("POST", `/api/partner/training/${t.id}/assessment`, { cookie: p.cookie, body: { applicationId, result: "Passed", score: 82, note: "Well done." } });
    assert.equal(passed.json.participants[0].assessment.result, "Passed");
    assert.deepEqual(passed.json.participants[0].missing, []);

    mine = await call("GET", "/api/training", { cookie: o.cookie });
    assert.deepEqual(mine.json.items[0].sessions.map((s) => s.present), [true, true]);
    assert.equal(mine.json.items[0].attended, 2);
    assert.deepEqual({ result: mine.json.items[0].assessment.result, score: mine.json.items[0].assessment.score }, { result: "Passed", score: 82 });

    const done = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: { note: "Completed the course." } });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const row = done.json.participants[0];
    assert.equal(row.status, "Completed");
    assert.match(row.certificateCode, /^NMC-[A-Z2-9]{10}$/);

    // The owner sees the certificate and is told.
    mine = await call("GET", "/api/training", { cookie: o.cookie });
    assert.equal(mine.json.items[0].status, "Completed");
    assert.equal(mine.json.items[0].certificate.code, row.certificateCode);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /certificate is ready/ }), 1);
    const app = await call("GET", `/api/applications/${applicationId}`, { cookie: o.cookie });
    assert.equal(app.json.application.status, "Completed");

    // Anyone with the code can check it, and it says only who, what, by whom and when.
    const check = await call("GET", `/api/certificates/${row.certificateCode.toLowerCase()}`);
    assert.equal(check.status, 200);
    assert.equal(check.json.certificate.holderName, "Ada Obi");
    assert.equal(check.json.certificate.training, "Bookkeeping basics");
    assert.equal(check.json.certificate.businessName, o.business);
    assert.ok(check.json.certificate.issuedAt);
    assert.ok(!check.text.includes(o.email) && !check.text.includes(o.phone), "no contact details");
    assert.equal((await call("GET", `/api/certificates/${row.certificateCode.replace("-", " ")}`)).status, 200, "a space for the hyphen is understood");

    // Finished: nothing about this participant can change, and it cannot be completed twice.
    assert.equal((await mark(t.sessions[0], false)).status, 409);
    assert.equal((await call("POST", `/api/partner/training/${t.id}/assessment`, { cookie: p.cookie, body: { applicationId, result: "Failed" } })).json.error.code, "already_completed");
    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} })).json.error.code, "already_completed");
  });

  it("refuses marks for people who are not participants, unknown sessions, and bad input", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const waiting = await owner();
    const pending = await call("POST", "/api/applications", { cookie: waiting.cookie, body: { opportunityId: t.id, message: "", submit: true, consent: { summary: true } } });
    const attend = (body) => call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body });

    const notYet = await attend({ sessionId: t.sessions[0], marks: [{ applicationId: pending.json.application.id, present: true }] });
    assert.equal(notYet.status, 422, "an application that is not approved");
    assert.ok(notYet.json.error.fields["marks.0.applicationId"]);
    assert.equal((await attend({ sessionId: "a".repeat(24), marks: [{ applicationId, present: true }] })).json.error.fields.sessionId, "Choose one of this training's sessions.");
    assert.equal((await attend({ sessionId: t.sessions[0], marks: [] })).status, 422);
    assert.equal((await attend({ sessionId: t.sessions[0], marks: [{ applicationId, present: "yes" }] })).status, 422);
    assert.equal((await attend({ sessionId: t.sessions[0], marks: [{ applicationId, present: true }], extra: 1 })).status, 422);
    const assess = (body) => call("POST", `/api/partner/training/${t.id}/assessment`, { cookie: p.cookie, body });
    assert.equal((await assess({ applicationId, result: "Excellent" })).status, 422);
    assert.equal((await assess({ applicationId, result: "Passed", score: 101 })).status, 422);
    assert.equal((await assess({ applicationId: pending.json.application.id, result: "Passed" })).status, 422);
    assert.equal((await assess({ applicationId, result: "Passed", score: "" })).status, 200, "a result without a score is fine");
  });

  it("a training with no rules can be completed straight after approval", async () => {
    const p = await provider();
    const t = await openTraining(p, { plan: { minSessions: 0, requirePass: false } });
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const done = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.json.participants[0].status, "Completed");
  });
});

describe("who can see and do what", () => {
  it("a provider sees only its own trainings and, for each participant, only what the owner agreed to share", async () => {
    const p = await provider();
    const other = await provider();
    const t = await openTraining(p);
    const closed = await owner({ fullName: "Private Person" });
    const open = await owner({ fullName: "Open Person" });
    await register(closed, p, t.id, { summary: true });
    await register(open, p, t.id, { summary: true, contact: true });

    const detail = await training(p, t.id);
    const ownerNames = detail.json.participants.map((x) => x.ownerName);
    assert.ok(ownerNames.includes("Open Person"), "contact was shared");
    assert.ok(ownerNames.includes(null), "contact was not shared for the other participant");
    assert.ok(detail.json.participants.every((x) => x.businessName), "the summary is always shared");
    assert.ok(!detail.text.includes("Private Person"), "contact was not shared");
    assert.ok(!detail.text.includes(closed.email) && !detail.text.includes(open.phone));

    assert.equal((await call("GET", `/api/partner/training/${t.id}`, { cookie: other.cookie })).status, 404, "another organisation");
    assert.equal((await call("PUT", `/api/partner/training/${t.id}/plan`, { cookie: other.cookie, body: { mode: "Online" } })).status, 404);
    assert.deepEqual((await call("GET", "/api/partner/training", { cookie: other.cookie })).json.items, []);

    // NMREP staff see every training and every participant's name.
    const adminList = await call("GET", "/api/admin/training", { cookie: admin });
    assert.ok(adminList.json.items.some((i) => i.id === t.id));
    const adminDetail = await call("GET", `/api/admin/training/${t.id}`, { cookie: admin });
    assert.ok(adminDetail.text.includes("Private Person"));
    const adminPlan = await call("PUT", `/api/admin/training/${t.id}/plan`, { cookie: admin, body: { mode: "Online", sessions: [], minSessions: 0 } });
    assert.equal(adminPlan.status, 200);
  });

  it("owners, anonymous visitors and the wrong kind of staff are refused", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    for (const [method, path] of [["GET", "/api/partner/training"], ["GET", `/api/partner/training/${t.id}`], ["GET", "/api/admin/training"], ["GET", `/api/admin/training/${t.id}`]]) {
      assert.equal((await call(method, path)).status, 401, `anonymous ${path}`);
      assert.equal((await call(method, path, { cookie: o.cookie })).status, 403, `owner ${path}`);
    }
    assert.equal((await call("GET", "/api/admin/training", { cookie: p.cookie })).status, 403, "a partner is not NMREP staff");
    assert.equal((await call("GET", "/api/partner/training", { cookie: admin })).status, 403, "NMREP staff use the admin routes");
    assert.equal((await call("GET", "/api/training")).status, 401);
    assert.equal((await call("GET", "/api/training", { cookie: p.cookie })).status, 403);
    assert.equal((await call("GET", "/api/training", { cookie: admin })).status, 403);
    assert.equal((await call("GET", "/api/partner/training/not-an-id", { cookie: p.cookie })).status, 404);
  });

  it("an owner sees only their own trainings", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const a = await owner();
    const b = await owner();
    await register(a, p, t.id);
    assert.equal((await call("GET", "/api/training", { cookie: a.cookie })).json.items.length, 1);
    assert.deepEqual((await call("GET", "/api/training", { cookie: b.cookie })).json.items, []);
  });
});

describe("the website can reach the plan route", () => {
  it("answers a browser's permission check (preflight) for PUT, which is how the plan is saved", async () => {
    const res = await fetch(`${ctx.base}/api/partner/training/${"a".repeat(24)}/plan`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /\bPUT\b/);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });
});

describe("certificates", () => {
  it("answers 404 for unknown and malformed codes, without saying which", async () => {
    assert.equal((await call("GET", "/api/certificates/NMC-AAAAAAAAAA")).status, 404);
    assert.equal((await call("GET", "/api/certificates/nonsense")).status, 404);
    assert.equal((await call("GET", "/api/certificates/NMC-0OIl1AAAAA")).status, 404);
    assert.equal((await call("GET", "/api/certificates/x".repeat(40))).status, 404);
  });

  it("stops working when the owner deletes their account, which also removes the training records", async () => {
    const p = await provider();
    const t = await openTraining(p, { plan: { minSessions: 0 } });
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const done = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} });
    const code = done.json.participants[0].certificateCode;
    assert.equal((await call("GET", `/api/certificates/${code}`)).status, 200);
    assert.equal(await TrainingRecord.countDocuments({ owner: o.id }), 1);
    assert.equal((await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Secret123" } })).status, 204);
    assert.equal(await TrainingRecord.countDocuments({ owner: o.id }), 0);
    assert.equal((await call("GET", `/api/certificates/${code}`)).status, 404);
  });
});
