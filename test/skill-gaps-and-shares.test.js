import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { setMailer } from "../src/lib/mailer.js";
import { runDocumentExpiryWarnings, runReminders } from "../src/lib/reminders.js";
import { Business } from "../src/models/Business.js";
import { ConsentRecord } from "../src/models/ConsentRecord.js";
import { Notification } from "../src/models/Notification.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The skill-gap loop (recommended trainings), "how to become eligible", the partner training report, and the warning
// before a document share ends with the option to extend it.

let ctx;
let call;
let admin;
let dir;
let counter = 0;
const key = crypto.randomBytes(32).toString("base64");
const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`doc-${crypto.randomUUID()}\n%%EOF`)]);
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-gaps-"));
  ctx = await startTestServer();
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  setDocumentStorage(createDocumentStorage(null));
  await ctx.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mails.sent = [];
  setMailer(mails, { notifications: true, appUrl: "https://nmrep.test" });
});

async function owner() {
  const res = await call("POST", "/api/auth/register", { body: registrationBody() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}
async function provider(type = "Training Provider") {
  counter += 1;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Gap partner ${counter} ${Date.now()}`, type } });
  const email = `gap${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, { cookie: admin, body: { fullName: "Tola Trainer", email, phone: "08011112222" } });
  const login = await logIn(call, email, created.json.temporaryPassword);
  await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "TrainerPass1" } });
  return { cookie: login.cookie };
}
async function publish(p, body) {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const id = c.json.opportunity.id;
  await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
  assert.equal((await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin })).status, 200);
  return id;
}
const training = (p, title, tags, mode = "Online") =>
  publish(p, { title, type: "Training", description: `${title} course.`, tags }).then(async (id) => {
    const saved = await call("PUT", `/api/partner/training/${id}/plan`, { cookie: p.cookie, body: { mode, venue: "", startsOn: "2030-03-01", endsOn: "2030-03-08", sessions: [{ title: "Day 1", on: "2030-03-01" }], minSessions: 1 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    return id;
  });
const setProfile = (o, body) => call("PATCH", "/api/business", { cookie: o.cookie, body });

describe("recommended trainings", () => {
  it("lists nothing until the owner names a skill gap", async () => {
    const p = await provider();
    await training(p, "Insurance basics", ["Insurance"]);
    const o = await owner();
    const res = await call("GET", "/api/training/recommended", { cookie: o.cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie })).json.recommendedTraining, 0);
  });

  it("puts the training that covers more gaps first, then the preferred format, and skips other trainings", async () => {
    const p = await provider();
    const both = await training(p, "Books and leadership", ["Accounting", "Leadership"], "In person");
    const onlineOne = await training(p, "Online accounting", ["Accounting"], "Online");
    const inPersonOne = await training(p, "In person accounting", ["Accounting"], "In person");
    await training(p, "Export for beginners", ["Export"]);
    await publish(p, { title: "A grant with the same tag", type: "Grant", description: "Not a training.", tags: ["Accounting"] });

    const o = await owner();
    assert.equal((await setProfile(o, { skillGaps: ["Accounting", "Leadership"], preferredFormat: "Online" })).status, 200);
    const res = await call("GET", "/api/training/recommended", { cookie: o.cookie });
    assert.deepEqual(res.json.items.map((i) => i.id), [both, onlineOne, inPersonOne]);
    assert.deepEqual(res.json.items[0].matchedGaps.sort(), ["Accounting", "Leadership"]);
    assert.equal(res.json.items[1].matchesFormat, true);
    assert.equal(res.json.items[2].matchesFormat, false);
    assert.deepEqual(res.json.skillGaps, ["Accounting", "Leadership"]);
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie })).json.recommendedTraining, 3);
  });

  it("leaves out a training the owner has already applied to", async () => {
    const p = await provider();
    const id = await training(p, "Applied already", ["Legal"]);
    const o = await owner();
    await setProfile(o, { skillGaps: ["Legal"] });
    assert.equal((await call("GET", "/api/training/recommended", { cookie: o.cookie })).json.items.length, 1);
    const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "Please.", submit: true, consent: { summary: true } } });
    assert.equal(app.status, 201, JSON.stringify(app.json));
    assert.equal((await call("GET", "/api/training/recommended", { cookie: o.cookie })).json.items.length, 0);
  });

  it("is for owners only", async () => {
    assert.equal((await call("GET", "/api/training/recommended")).status, 401);
    const p = await provider();
    assert.equal((await call("GET", "/api/training/recommended", { cookie: p.cookie })).status, 403);
  });
});

describe("how to become eligible", () => {
  it("lists the unmet requirements and the missing documents, and shrinks as the owner fixes them", async () => {
    const p = await provider("Bank");
    const id = await publish(p, {
      title: "Needs a lot",
      type: "Grant",
      description: "A programme.",
      criteria: [
        { key: "hasCac", level: "required" },
        { key: "verified", level: "required" },
        { key: "employees", level: "required", min: 500 },
      ],
      requiredDocuments: ["CAC Certificate"],
    });
    const o = await owner();
    await Business.updateOne({ _id: o.businessId }, { $set: { hasCac: "No", cacNumber: "", verificationStatus: "Unverified" } });
    const detail = await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie });
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    const how = detail.json.howToQualify;
    assert.equal(how.ready, false);
    const byKey = Object.fromEntries(how.steps.map((s) => [s.key, s]));
    assert.match(byKey.hasCac.title, /Corporate Affairs Commission/);
    assert.equal(byKey.verified.link, "/dashboard/verification/");
    assert.equal(byKey.employees.link, "/dashboard/profile/");
    assert.equal(byKey["CAC Certificate"].type, "document");
    assert.equal(byKey["CAC Certificate"].link, "/dashboard/documents/");

    // Adding the certificate removes the document step.
    const form = new FormData();
    form.set("kind", "CAC Certificate");
    form.set("title", "CAC");
    form.set("file", new Blob([pdf()], { type: "application/pdf" }), "scan.pdf");
    const up = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
    assert.equal(up.status, 201);
    const again = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json.howToQualify;
    assert.ok(!again.steps.some((s) => s.type === "document"));
    assert.equal(again.steps.length, how.steps.length - 1);
  });

  it("is ready when nothing is missing", async () => {
    const p = await provider("Bank");
    const id = await publish(p, { title: "Open to all", type: "Grant", description: "A programme." });
    const o = await owner();
    const how = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json.howToQualify;
    assert.deepEqual(how, { ready: true, steps: [] });
  });

  it("asks for any one member of an OR group, and lists nothing once one is met", async () => {
    const p = await provider("Bank");
    const id = await publish(p, {
      title: "Either one",
      type: "Grant",
      description: "A programme.",
      criteria: [
        { key: "hasCac", level: "required", group: 1 },
        { key: "hasTin", level: "required", group: 1 },
      ],
    });
    const o = await owner();
    await Business.updateOne({ _id: o.businessId }, { $set: { hasCac: "No", cacNumber: "", hasTin: "No", tin: "" } });
    const missing = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json.howToQualify;
    assert.equal(missing.steps.length, 1);
    assert.equal(missing.steps[0].anyOf.length, 2);
    await Business.updateOne({ _id: o.businessId }, { $set: { hasTin: "Yes", tin: "12345678-0001" } });
    assert.equal((await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json.howToQualify.ready, true);
  });
});

describe("the partner training report", () => {
  it("counts completion, attendance, pass rate and certificates, and only for the partner's own trainings", async () => {
    const p = await provider();
    const other = await provider();
    const t = await training(p, "Reported training", ["Export"], "Hybrid");
    await training(other, "Someone else's training", ["Export"]);
    const sessions = (await call("GET", `/api/partner/training/${t}`, { cookie: p.cookie })).json.opportunity.training.sessions.map((s) => s.id);

    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const o = await owner();
      const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: t, message: "Please.", submit: true, consent: { summary: true } } });
      assert.equal(app.status, 201, JSON.stringify(app.json));
      await call("POST", `/api/partner/applications/${app.json.application.id}/status`, { cookie: p.cookie, body: { status: "Approved", note: "Welcome." } });
      ids.push(app.json.application.id);
    }
    // Two present and one absent; the first is assessed as passed and completed.
    await call("POST", `/api/partner/training/${t}/attendance`, { cookie: p.cookie, body: { sessionId: sessions[0], marks: [{ applicationId: ids[0], present: true }, { applicationId: ids[1], present: true }, { applicationId: ids[2], present: false }] } });
    await call("POST", `/api/partner/training/${t}/assessment`, { cookie: p.cookie, body: { applicationId: ids[0], result: "Passed", score: 80 } });
    await call("POST", `/api/partner/training/${t}/assessment`, { cookie: p.cookie, body: { applicationId: ids[1], result: "Failed" } });
    assert.equal((await call("POST", `/api/partner/training/${t}/participants/${ids[0]}/complete`, { cookie: p.cookie, body: {} })).status, 200);

    const report = await call("GET", "/api/partner/training/report", { cookie: p.cookie });
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.equal(report.json.totals.trainings, 1);
    assert.equal(report.json.items.length, 1);
    const row = report.json.items[0];
    assert.equal(row.title, "Reported training");
    assert.equal(row.participants, 3);
    assert.equal(row.completed, 1);
    assert.equal(row.completionRate, 33.3);
    assert.equal(row.attendanceRate, 66.7);
    assert.equal(row.assessed, 2);
    assert.equal(row.passRate, 50);
    assert.equal(row.certificatesIssued, 1);
    assert.equal(row.certificatesWithdrawn, 0);
    assert.ok(!JSON.stringify(report.json).includes("@"), "no names or emails");

    const all = await call("GET", "/api/admin/training/report", { cookie: admin });
    assert.equal(all.status, 200);
    assert.ok(all.json.totals.trainings >= 2);

    assert.equal((await call("GET", "/api/partner/training/report")).status, 401);
  });

  it("has rates of null when there is nothing to divide", async () => {
    const p = await provider();
    await training(p, "Empty training", ["Export"]);
    const report = (await call("GET", "/api/partner/training/report", { cookie: p.cookie })).json;
    assert.equal(report.items[0].participants, 0);
    assert.equal(report.items[0].completionRate, null);
    assert.equal(report.items[0].attendanceRate, null);
    assert.equal(report.items[0].passRate, null);
  });
});

describe("a share that is about to end", () => {
  async function shared(days = 7) {
    const p = await provider("Bank");
    const opportunity = await publish(p, { title: "Share programme", type: "Grant", description: "A programme." });
    const o = await owner();
    const form = new FormData();
    form.set("kind", "CAC Certificate");
    form.set("title", "CAC");
    form.set("file", new Blob([pdf()], { type: "application/pdf" }), "scan.pdf");
    const up = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
    const doc = (await up.json()).document;
    const body = { opportunityId: opportunity, message: "Please.", submit: true, consent: { summary: true, documents: true }, documentIds: [doc.id] };
    if (days) body.documentsShareDays = days;
    const app = await call("POST", "/api/applications", { cookie: o.cookie, body });
    assert.equal(app.status, 201, JSON.stringify(app.json));
    const consent = await ConsentRecord.findOne({ application: app.json.application.id });
    return { o, p, consent };
  }

  it("warns the owner once, three days or less before the end, and again after an extension", async () => {
    const { o, consent } = await shared(7);
    assert.equal(await runDocumentExpiryWarnings(new Date()), 0, "seven days away: no warning yet");

    await ConsentRecord.updateOne({ _id: consent._id }, { $set: { documentsExpireAt: new Date(Date.now() + 2 * DAY) } });
    assert.equal(await runDocumentExpiryWarnings(new Date()), 1);
    assert.equal(await runDocumentExpiryWarnings(new Date()), 0, "never twice for the same end date");
    const notes = await Notification.find({ user: o.id, title: /stop being shared/ });
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /extend/);
    assert.equal(notes[0].link, "/dashboard/sharing/");

    const list = await call("GET", "/api/consents", { cookie: o.cookie });
    assert.equal(list.json.items[0].documentsEndingSoon, true);

    // Extending moves the end date, so the new end date gets its own warning when it comes.
    assert.equal((await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: o.cookie, body: { days: 7 } })).status, 200);
    await ConsentRecord.updateOne({ _id: consent._id }, { $set: { documentsExpireAt: new Date(Date.now() + DAY) } });
    assert.equal(await runDocumentExpiryWarnings(new Date()), 1);
  });

  it("does not warn about a share that was stopped, has no end date, or whose application was withdrawn", async () => {
    const forever = await shared(null);
    assert.equal((await ConsentRecord.findById(forever.consent._id)).documentsExpireAt, null);
    const ended = await shared(7);
    await ConsentRecord.updateOne({ _id: ended.consent._id }, { $set: { documentsExpireAt: new Date(Date.now() + DAY), revokedAt: new Date() } });
    const stopped = await shared(7);
    await ConsentRecord.updateOne({ _id: stopped.consent._id }, { $set: { documentsExpireAt: new Date(Date.now() - 1000) } });
    assert.equal(await runDocumentExpiryWarnings(new Date()), 0);
  });

  it("runs as part of the reminder job", async () => {
    const result = await runReminders(new Date());
    assert.equal(typeof result.documents, "number");
  });

  it("extends from the old end date, in steps of 7, 30, 90 or 180 days", async () => {
    const { o, consent } = await shared(7);
    const before = consent.documentsExpireAt.getTime();
    const res = await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: o.cookie, body: { days: 30 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(Math.round((new Date(res.json.consent.documentsExpireAt).getTime() - before) / DAY), 30);
    assert.equal(res.json.consent.documentsSharing, true);

    for (const bad of [{}, { days: 10 }, { days: "30" }, { days: 30, extra: 1 }]) {
      assert.equal((await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: o.cookie, body: bad })).status, 422, JSON.stringify(bad));
    }
  });

  it("renews a share that has already ended on its own, counting from today", async () => {
    const { o, consent } = await shared(7);
    await ConsentRecord.updateOne({ _id: consent._id }, { $set: { documentsExpireAt: new Date(Date.now() - 5 * DAY) } });
    const res = await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: o.cookie, body: { days: 7 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const days = (new Date(res.json.consent.documentsExpireAt).getTime() - Date.now()) / DAY;
    assert.ok(days > 6.9 && days < 7.1, String(days));
    assert.equal(res.json.consent.documentsSharing, true);
  });

  it("refuses when there is no end date, the application was withdrawn, or the agreement is not yours", async () => {
    const forever = await shared(null);
    const noEnd = await call("POST", `/api/consents/${forever.consent.id}/extend-documents`, { cookie: forever.o.cookie, body: { days: 7 } });
    assert.equal(noEnd.status, 409);
    assert.equal(noEnd.json.error.code, "no_end_date");

    const { o, consent } = await shared(7);
    const stranger = await owner();
    assert.equal((await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: stranger.cookie, body: { days: 7 } })).status, 404);
    await ConsentRecord.updateOne({ _id: consent._id }, { $set: { revokedAt: new Date() } });
    const ended = await call("POST", `/api/consents/${consent.id}/extend-documents`, { cookie: o.cookie, body: { days: 7 } });
    assert.equal(ended.status, 409);
    assert.equal(ended.json.error.code, "ended");
    assert.equal((await call("POST", `/api/consents/${consent.id}/extend-documents`, { body: { days: 7 } })).status, 401);
  });
});
