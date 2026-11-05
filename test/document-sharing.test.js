import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { mailer, setMailer } from "../src/lib/mailer.js";
import { ConsentRecord } from "../src/models/ConsentRecord.js";
import { DocumentAccess } from "../src/models/DocumentAccess.js";
import { Notification } from "../src/models/Notification.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Sharing controls on the document wallet: an end date for shared documents, stopping early, and the owner being told
// (and able to see) when an organisation or NMREP opens one of their documents.

let ctx;
let call;
let admin;
let dir;
let counter = 0;
const key = crypto.randomBytes(32).toString("base64");
const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };
const pdf = (text = "contract") => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`${text}-${crypto.randomUUID()}\n%%EOF`)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-sharing-"));
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
  return { cookie: res.cookie, id: res.json.user.id, email: res.json.user.email, businessId: res.json.business.id };
}
async function partner() {
  counter += 1;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Sharing Bank ${counter} ${Date.now()}`, type: "Bank" } });
  const email = `sharing${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, { cookie: admin, body: { fullName: "Pat Partner", email, phone: "08011112222" } });
  const login = await logIn(call, email, created.json.temporaryPassword);
  await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "PartnerPass1" } });
  return { cookie: login.cookie, name: org.json.organisation.name };
}
async function openOpportunity(p) {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { title: "Sharing programme", type: "Grant", description: "A programme." } });
  const id = c.json.opportunity.id;
  await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
  await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin });
  return id;
}
async function upload(o, { kind = "CAC Certificate", title = "CAC" } = {}) {
  const form = new FormData();
  form.set("kind", kind);
  form.set("title", title);
  form.set("file", new Blob([pdf()], { type: "application/pdf" }), "scan.pdf");
  const res = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
  assert.equal(res.status, 201);
  return (await res.json()).document;
}
const apply = (o, opportunityId, body = {}) =>
  call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId, message: "Please.", submit: true, consent: { summary: true, documents: true }, ...body } });
const open = (p, applicationId, docId) => fetch(`${ctx.base}/api/partner/applications/${applicationId}/documents/${docId}`, { headers: { Origin: ORIGIN, Cookie: p.cookie } });

/** A shared document: an owner applies to a partner's opportunity with one document attached. */
async function shared(extra = {}, docOptions = {}) {
  const p = await partner();
  const opportunity = await openOpportunity(p);
  const o = await owner();
  const doc = await upload(o, docOptions);
  const app = await apply(o, opportunity, { documentIds: [doc.id], ...extra });
  assert.equal(app.status, 201, JSON.stringify(app.json));
  return { p, o, doc, applicationId: app.json.application.id };
}

describe("an end date for shared documents", () => {
  it("shares until the application is withdrawn when no end date is chosen, as before", async () => {
    const { p, o, doc, applicationId } = await shared();
    const consents = await call("GET", "/api/consents", { cookie: o.cookie });
    assert.equal(consents.json.items[0].documentsExpireAt, null);
    assert.equal(consents.json.items[0].documentsSharing, true);
    assert.equal((await open(p, applicationId, doc.id)).status, 200);
  });

  it("ends by itself on the chosen day: the organisation can no longer see or open the documents", async () => {
    const { p, o, doc, applicationId } = await shared({ documentsShareDays: 30 });
    const consent = (await call("GET", "/api/consents", { cookie: o.cookie })).json.items[0];
    const days = (new Date(consent.documentsExpireAt) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 29.9 && days <= 30);
    assert.equal(consent.documentsSharing, true);
    assert.equal((await call("GET", `/api/partner/applications/${applicationId}`, { cookie: p.cookie })).json.documents.length, 1);

    // Time passes.
    await ConsentRecord.updateOne({ application: applicationId }, { $set: { documentsExpireAt: new Date(Date.now() - 1000) } });
    assert.equal((await call("GET", `/api/partner/applications/${applicationId}`, { cookie: p.cookie })).json.documents.length, 0);
    assert.equal((await open(p, applicationId, doc.id)).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/admin/applications/${applicationId}/documents/${doc.id}`, { headers: { Origin: ORIGIN, Cookie: admin } })).status, 404, "NMREP staff too");
    const after = (await call("GET", "/api/consents", { cookie: o.cookie })).json.items[0];
    assert.equal(after.documentsSharing, false);
    const mine = (await call("GET", "/api/documents", { cookie: o.cookie })).json.items.find((d) => d.id === doc.id);
    assert.deepEqual(mine.sharedWith, [], "the wallet no longer lists it as shared");
    const application = await call("GET", `/api/applications/${applicationId}`, { cookie: o.cookie });
    assert.equal(application.status, 200, "the application itself is untouched");
  });

  it("shows the end date on the wallet while the sharing lasts", async () => {
    const { o, doc } = await shared({ documentsShareDays: 7 });
    const mine = (await call("GET", "/api/documents", { cookie: o.cookie })).json.items.find((d) => d.id === doc.id);
    assert.equal(mine.sharedWith.length, 1);
    assert.ok(mine.sharedWith[0].until);
  });

  it("accepts only 7, 30, 90 or 180 days, and only when documents are being shared", async () => {
    const p = await partner();
    const opportunity = await openOpportunity(p);
    const o = await owner();
    const doc = await upload(o);
    for (const bad of [5, 365, 0, "30", 30.5]) {
      const res = await apply(o, opportunity, { documentIds: [doc.id], documentsShareDays: bad });
      assert.equal(res.status, 422, String(bad));
      assert.ok(res.json.error.fields.documentsShareDays, String(bad));
    }
    const none = await apply(o, opportunity, { documentIds: [doc.id], documentsShareDays: null });
    assert.equal(none.status, 201);
    assert.equal((await ConsentRecord.findOne({ application: none.json.application.id })).documentsExpireAt, null);
    const noDocs = await apply(await owner(), opportunity, { consent: { summary: true }, documentsShareDays: 30 });
    assert.equal(noDocs.status, 201);
    assert.equal((await ConsentRecord.findOne({ application: noDocs.json.application.id })).documentsExpireAt, null, "nothing shared, so no end date");
  });
});

describe("stopping the sharing early", () => {
  it("ends the sharing of the documents now, keeps the application, and cannot be done twice", async () => {
    const { p, o, doc, applicationId } = await shared();
    const consent = (await call("GET", "/api/consents", { cookie: o.cookie })).json.items[0];
    const stop = await call("POST", `/api/consents/${consent.id}/stop-documents`, { cookie: o.cookie });
    assert.equal(stop.status, 200, JSON.stringify(stop.json));
    assert.equal(stop.json.consent.documentsSharing, false);
    assert.equal((await open(p, applicationId, doc.id)).status, 404);
    assert.equal((await call("GET", `/api/partner/applications/${applicationId}`, { cookie: p.cookie })).status, 200, "the organisation still sees the application");
    const again = await call("POST", `/api/consents/${consent.id}/stop-documents`, { cookie: o.cookie });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "not_sharing");
  });

  it("is only for the owner of the agreement", async () => {
    const { p, o, applicationId } = await shared();
    const consent = (await call("GET", "/api/consents", { cookie: o.cookie })).json.items[0];
    assert.equal((await call("POST", `/api/consents/${consent.id}/stop-documents`, { cookie: (await owner()).cookie })).status, 404);
    assert.equal((await call("POST", `/api/consents/${consent.id}/stop-documents`, { cookie: p.cookie })).status, 403);
    assert.equal((await call("POST", `/api/consents/${consent.id}/stop-documents`, {})).status, 401);
    assert.equal((await call("POST", "/api/consents/not-an-id/stop-documents", { cookie: o.cookie })).status, 404);
    assert.equal((await ConsentRecord.findOne({ application: applicationId })).documentsExpireAt, null, "nothing changed");
  });

  it("says nothing is being shared when no documents were attached", async () => {
    const p = await partner();
    const opportunity = await openOpportunity(p);
    const o = await owner();
    const app = await apply(o, opportunity, { consent: { summary: true } });
    const consent = await ConsentRecord.findOne({ application: app.json.application.id });
    assert.equal((await call("POST", `/api/consents/${consent._id}/stop-documents`, { cookie: o.cookie })).status, 409);
  });
});

describe("telling the owner when a document is opened", () => {
  it("records who opened it and notifies the owner, naming the organisation and the kind of document, once a day", async () => {
    const { p, o, doc, applicationId } = await shared({}, { kind: "CAC Certificate", title: "My private CAC title" });
    mails.sent = [];
    assert.equal((await open(p, applicationId, doc.id)).status, 200);
    assert.equal((await open(p, applicationId, doc.id)).status, 200);

    const notices = await Notification.find({ user: o.id, title: /opened your/ });
    assert.equal(notices.length, 1, "told once, though it was opened twice");
    assert.equal(notices[0].title, `${p.name} opened your CAC Certificate`);
    assert.ok(!notices[0].title.includes("private CAC title") && !notices[0].body.includes("private"), "never the title of the document");
    assert.equal(notices[0].link, "/dashboard/documents/");
    await mailer.flush();
    assert.ok(mails.sent.some((m) => m.to === o.email && /opened your CAC Certificate/.test(m.subject)), "and by email");
    assert.equal(await DocumentAccess.countDocuments({ document: doc.id }), 2, "both openings are on record");

    const mine = (await call("GET", "/api/documents", { cookie: o.cookie })).json.items.find((d) => d.id === doc.id);
    assert.equal(mine.opened.length, 2);
    assert.equal(mine.opened[0].by, p.name);
    assert.equal(mine.opened[0].purpose, "Application");
    assert.deepEqual(Object.keys(mine.opened[0]).sort(), ["at", "by", "purpose"]);
  });

  it("calls a sensitive document only 'one of your documents' in the notice", async () => {
    const { p, o, doc, applicationId } = await shared({}, { kind: "Bank Statement", title: "March" });
    await open(p, applicationId, doc.id);
    const notice = await Notification.findOne({ user: o.id, title: /opened/ });
    assert.equal(notice.title, `${p.name} opened one of your documents`);
  });

  it("records NMREP staff opening it too, for an application and for verification", async () => {
    const { o, doc, applicationId } = await shared();
    assert.equal((await fetch(`${ctx.base}/api/admin/applications/${applicationId}/documents/${doc.id}`, { headers: { Origin: ORIGIN, Cookie: admin } })).status, 200);
    const notice = await Notification.findOne({ user: o.id, title: "NMREP opened your CAC Certificate" });
    assert.ok(notice);
    const record = await DocumentAccess.findOne({ document: doc.id, by: "NMREP" });
    assert.equal(record.purpose, "Application");
  });

  it("records a verification review too, as Verification", async () => {
    const o = await owner();
    const doc = await upload(o, { kind: "CAC Certificate", title: "For review" });
    const put = await call("PUT", "/api/verification/documents", { cookie: o.cookie, body: { documentIds: [doc.id], agree: true } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const got = await fetch(`${ctx.base}/api/admin/businesses/${o.businessId}/documents/${doc.id}`, { headers: { Origin: ORIGIN, Cookie: admin } });
    assert.equal(got.status, 200);
    const record = await DocumentAccess.findOne({ document: doc.id });
    assert.equal(record.by, "NMREP");
    assert.equal(record.purpose, "Verification");
    assert.ok(await Notification.exists({ user: o.id, title: "NMREP opened your CAC Certificate" }));
  });

  it("does not tell the owner, or record anything, when the open is refused", async () => {
    const { p, o, doc, applicationId } = await shared({ documentsShareDays: 7 });
    await ConsentRecord.updateOne({ application: applicationId }, { $set: { documentsExpireAt: new Date(Date.now() - 1000) } });
    assert.equal((await open(p, applicationId, doc.id)).status, 404);
    assert.equal(await DocumentAccess.countDocuments({ document: doc.id }), 0);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /opened/ }), 0);
  });

  it("goes with the document and with the account", async () => {
    const { p, o, doc, applicationId } = await shared();
    await open(p, applicationId, doc.id);
    assert.equal(await DocumentAccess.countDocuments({ owner: o.id }), 1);
    assert.equal((await call("DELETE", `/api/documents/${doc.id}`, { cookie: o.cookie })).status, 204);
    assert.equal(await DocumentAccess.countDocuments({ owner: o.id }), 0, "deleting the document deletes its history");

    const second = await shared();
    await open(second.p, second.applicationId, second.doc.id);
    assert.equal((await call("DELETE", "/api/account", { cookie: second.o.cookie, body: { password: "Secret123" } })).status, 204);
    assert.equal(await DocumentAccess.countDocuments({ owner: second.o.id }), 0, "deleting the account deletes it too");
  });
});
