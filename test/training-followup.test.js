import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mailer, setMailer } from "../src/lib/mailer.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Notification } from "../src/models/Notification.js";
import { TrainingRecord } from "../src/models/TrainingRecord.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// After a training: withdrawing and reissuing a certificate, the participant spreadsheet, and the notices (and emails)
// owners get about attendance and results.

let ctx;
let call;
let admin;
let counter = 0;
const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});
beforeEach(() => {
  mails.sent = [];
  setMailer(mails, { notifications: true, appUrl: "https://nmrep.test" });
});

async function owner(account = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ account }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, email: res.json.user.email, business: res.json.business.businessName };
}

async function provider() {
  counter += 1;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Follow-up provider ${counter} ${Date.now()}`, type: "Training Provider" } });
  const email = `followup${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, { cookie: admin, body: { fullName: "Tola Trainer", email, phone: "08011112222" } });
  const login = await logIn(call, email, created.json.temporaryPassword);
  await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "TrainerPass1" } });
  return { cookie: login.cookie };
}

async function openTraining(p, title = "Bookkeeping basics") {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { title, type: "Training", description: "Learn to keep simple books." } });
  const id = c.json.opportunity.id;
  await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
  await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin });
  const saved = await call("PUT", `/api/partner/training/${id}/plan`, {
    cookie: p.cookie,
    body: { mode: "Hybrid", venue: "12 Allen Avenue, Ikeja", startsOn: "2030-03-01", endsOn: "2030-03-08", sessions: [{ title: "Day 1", on: "2030-03-01" }, { title: "Day 2", on: "2030-03-08" }], minSessions: 1, requirePass: false },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return { id, sessions: saved.json.opportunity.training.sessions.map((s) => s.id) };
}

async function register(o, p, trainingId, consent = { summary: true }) {
  const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: trainingId, message: "Please enrol us.", submit: true, consent } });
  assert.equal(app.status, 201, JSON.stringify(app.json));
  const applicationId = app.json.application.id;
  assert.equal((await call("POST", `/api/partner/applications/${applicationId}/status`, { cookie: p.cookie, body: { status: "Approved", note: "Welcome." } })).status, 200);
  return applicationId;
}

/** A finished participant: attended the first session and completed. */
async function completed(p, t, o, applicationId) {
  const marked = await call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body: { sessionId: t.sessions[0], marks: [{ applicationId, present: true }] } });
  assert.equal(marked.status, 200, JSON.stringify(marked.json));
  const done = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/complete`, { cookie: p.cookie, body: {} });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return done.json.participants.find((x) => x.applicationId === applicationId).certificateCode;
}

const sentTo = (email) => mails.sent.filter((m) => m.to === email);

describe("withdrawing and reissuing a certificate", () => {
  it("a withdrawn certificate still resolves but says it is no longer valid, and the owner is told", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const code = await completed(p, t, o, applicationId);

    const valid = await call("GET", `/api/certificates/${code}`);
    assert.equal(valid.json.certificate.status, "valid");
    assert.equal(valid.json.certificate.revokedOn, null);

    const noReason = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: p.cookie, body: {} });
    assert.equal(noReason.status, 422, "a reason is required");

    mails.sent = [];
    const revoked = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: p.cookie, body: { reason: "Issued to the wrong person." } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    const row = revoked.json.participants[0];
    assert.equal(row.certificateCode, null);
    assert.ok(row.certificateWithdrawnOn);
    assert.equal(row.status, "Completed", "the participant stays completed");

    const check = await call("GET", `/api/certificates/${code}`);
    assert.equal(check.status, 200);
    assert.equal(check.json.certificate.status, "revoked");
    assert.ok(check.json.certificate.revokedOn);
    assert.ok(!check.text.includes("wrong person"), "the reason is never public");

    const mine = await call("GET", "/api/training", { cookie: o.cookie });
    assert.equal(mine.json.items[0].certificate, null);
    assert.ok(mine.json.items[0].certificateWithdrawnOn);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /certificate was withdrawn/ }), 1);
    await mailer.flush();
    assert.ok(sentTo(o.email).some((m) => /certificate was withdrawn/.test(m.subject)), "and emailed");

    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: p.cookie, body: { reason: "Again" } })).json.error.code, "no_certificate");
    const entry = await AuditLog.findOne({ action: "training.certificate.revoke" }).sort({ at: -1 });
    assert.match(entry.summary, /wrong person/);
  });

  it("reissuing gives a new code and keeps the old one invalid; replacing a valid one withdraws it first", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const first = await completed(p, t, o, applicationId);

    const replaced = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/reissue`, { cookie: p.cookie, body: { reason: "Business name corrected." } });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    const second = replaced.json.participants[0].certificateCode;
    assert.match(second, /^NMC-[A-Z2-9]{10}$/);
    assert.notEqual(second, first);
    assert.equal((await call("GET", `/api/certificates/${first}`)).json.certificate.status, "revoked");
    assert.equal((await call("GET", `/api/certificates/${second}`)).json.certificate.status, "valid");
    assert.equal(await Notification.countDocuments({ user: o.id, title: /new certificate is ready/ }), 1);

    // Withdraw and then reissue.
    await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: p.cookie, body: { reason: "Check." } });
    const again = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/reissue`, { cookie: p.cookie, body: {} });
    const third = again.json.participants[0].certificateCode;
    assert.ok(third && third !== first && third !== second);
    const mine = await call("GET", "/api/training", { cookie: o.cookie });
    assert.equal(mine.json.items[0].certificate.code, third);
    assert.equal(mine.json.items[0].certificateWithdrawnOn, null);
    const record = await TrainingRecord.findOne({ owner: o.id });
    assert.equal(record.revoked.length, 2);
  });

  it("only works on completed participants, and only for the provider's own trainings or for staff", async () => {
    const p = await provider();
    const other = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    const notYet = await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/reissue`, { cookie: p.cookie, body: {} });
    assert.equal(notYet.status, 404, "an approved participant has no certificate to reissue");
    const code = await completed(p, t, o, applicationId);

    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: other.cookie, body: { reason: "Not mine" } })).status, 404);
    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: o.cookie, body: { reason: "Owner" } })).status, 403);
    assert.equal((await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { body: { reason: "Anon" } })).status, 401);

    const byStaff = await call("POST", `/api/admin/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: admin, body: { reason: "Staff decision." } });
    assert.equal(byStaff.status, 200, JSON.stringify(byStaff.json));
    assert.equal((await call("GET", `/api/certificates/${code}`)).json.certificate.status, "revoked");
  });
});

describe("the participant spreadsheet", () => {
  it("lists participants with attendance, results and certificate, as a download", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner({ fullName: "Ada Obi" });
    const applicationId = await register(o, p, t.id, { summary: true, contact: true });
    await completed(p, t, o, applicationId);
    await call("POST", `/api/partner/training/${t.id}/participants/${applicationId}/certificate/revoke`, { cookie: p.cookie, body: { reason: "Test." } });

    const res = await call("GET", `/api/admin/training/${t.id}/participants.csv`, { cookie: admin });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="training-participants.csv"/);
    const lines = res.text.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines[0], '"Business","Owner","Status","Session: Day 1","Session: Day 2","Sessions attended","Assessment","Score","Completed on","Certificate"');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes('"Ada Obi"'));
    assert.ok(lines[1].includes('"Completed","Present","Not recorded","1"'));
    assert.ok(lines[1].endsWith('"Withdrawn"'));
    const entry = await AuditLog.findOne({ action: "training.export" }).sort({ at: -1 });
    assert.ok(entry);
  });

  it("gives a provider only what each owner agreed to share, and nothing to anyone else", async () => {
    const p = await provider();
    const other = await provider();
    const t = await openTraining(p);
    const shared = await owner({ fullName: "Shared Person" });
    const quiet = await owner({ fullName: "Quiet Person" });
    await register(shared, p, t.id, { summary: true, contact: true });
    await register(quiet, p, t.id, { summary: true });

    const res = await call("GET", `/api/partner/training/${t.id}/participants.csv`, { cookie: p.cookie });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Shared Person"));
    assert.ok(!res.text.includes("Quiet Person"), "an owner who did not share the contact choice is not named");
    assert.ok(res.text.includes("Not shared"));
    assert.ok(!res.text.includes(shared.email), "no contact details are ever in it");

    assert.equal((await call("GET", `/api/partner/training/${t.id}/participants.csv`, { cookie: other.cookie })).status, 404);
    assert.equal((await call("GET", `/api/partner/training/${t.id}/participants.csv`, { cookie: shared.cookie })).status, 403);
    assert.equal((await call("GET", `/api/partner/training/${t.id}/participants.csv`, {})).status, 401);
  });

  it("makes a name that starts with a formula character safe to open in a spreadsheet", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner({ fullName: "=HYPERLINK(\"http://evil.test\")" });
    await register(o, p, t.id, { summary: true, contact: true });
    const res = await call("GET", `/api/admin/training/${t.id}/participants.csv`, { cookie: admin });
    assert.ok(!res.text.includes('"=HYPERLINK'), "the formula is not left as it was");
    assert.ok(res.text.includes("\"'=HYPERLINK"));
  });
});

describe("notices about attendance and results", () => {
  it("tells the owner what was recorded, once, and emails it", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    mails.sent = [];
    const mark = (present) => call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body: { sessionId: t.sessions[0], marks: [{ applicationId, present }] } });

    assert.equal((await mark(true)).status, 200);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /Attendance recorded as present: Bookkeeping basics/ }), 1);
    await mark(true);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /Attendance recorded/ }), 1, "marking the same thing again says nothing new");
    await mark(false);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /Attendance recorded as absent/ }), 1, "a corrected mark is told");
    await mailer.flush();
    assert.equal(sentTo(o.email).filter((m) => /Attendance recorded/.test(m.subject)).length, 2);

    const result = await call("POST", `/api/partner/training/${t.id}/assessment`, { cookie: p.cookie, body: { applicationId, result: "Passed", score: 90, note: "Private feedback for the owner." } });
    assert.equal(result.status, 200);
    const notice = await Notification.findOne({ user: o.id, title: /Assessment result for Bookkeeping basics: Passed/ });
    assert.ok(notice);
    assert.equal(notice.body, "", "the assessor's note is not put in the notice");
    await mailer.flush();
    const email = sentTo(o.email).find((m) => /Assessment result/.test(m.subject));
    assert.ok(email);
    assert.ok(!email.text.includes("Private feedback"));
  });

  it("does not email an owner who switched emails off, but still tells them in the app", async () => {
    const p = await provider();
    const t = await openTraining(p);
    const o = await owner();
    const applicationId = await register(o, p, t.id);
    await call("PATCH", "/api/account/notification-settings", { cookie: o.cookie, body: { email: false } });
    mails.sent = [];
    await call("POST", `/api/partner/training/${t.id}/attendance`, { cookie: p.cookie, body: { sessionId: t.sessions[0], marks: [{ applicationId, present: true }] } });
    await mailer.flush();
    assert.equal(await Notification.countDocuments({ user: o.id, title: /Attendance recorded/ }), 1);
    assert.equal(sentTo(o.email).length, 0);
  });
});
