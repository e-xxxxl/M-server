import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { setMailer } from "../src/lib/mailer.js";
import { Agent } from "../src/models/Agent.js";
import { Application } from "../src/models/Application.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { Business } from "../src/models/Business.js";
import { ConsentRecord } from "../src/models/ConsentRecord.js";
import { Document } from "../src/models/Document.js";
import { Notification } from "../src/models/Notification.js";
import { Opportunity } from "../src/models/Opportunity.js";
import { Organisation } from "../src/models/Organisation.js";
import { Payment } from "../src/models/Payment.js";
import { Product } from "../src/models/Product.js";
import { Session } from "../src/models/Session.js";
import { TrainingRecord } from "../src/models/TrainingRecord.js";
import { User } from "../src/models/User.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Permanent deletion is for the super admin only, and each call needs the password, a reason and the name typed out.

let ctx;
let call;
let dir;
let sup;
let supCookie;
let admin;
let adminCookie;
const key = crypto.randomBytes(32).toString("base64");
const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-permanent-"));
  ctx = await startTestServer({ RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
  sup = await createStaff({ role: "super_admin" });
  supCookie = (await logIn(call, sup.email, sup.password)).cookie;
  admin = await createStaff({ role: "admin" });
  adminCookie = (await logIn(call, admin.email, admin.password)).cookie;
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

const body = (confirm, over = {}) => ({ password: sup.password, reason: "Requested by the owner.", confirm, ...over });
const del = (kind, id, b, cookie = supCookie) => call("DELETE", `/api/admin/permanent/${kind}/${id}`, { cookie, body: b });

async function owner() {
  const reg = registrationBody();
  const res = await call("POST", "/api/auth/register", { body: reg });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, email: res.json.user.email, businessId: res.json.business.id, businessName: res.json.business.businessName };
}
async function openOpportunity(title = "Test grant") {
  const c = await call("POST", "/api/admin/opportunities", { cookie: supCookie, body: { title, provider: "Example Foundation", type: "Grant", description: "A grant." } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  await call("PATCH", `/api/admin/opportunities/${c.json.opportunity.id}`, { cookie: supCookie, body: { status: "Open" } });
  return c.json.opportunity.id;
}

describe("who may delete permanently", () => {
  it("only the super admin: admins, owners and visitors are refused, and nothing is deleted", async () => {
    const o = await owner();
    const b = body(o.businessName);
    assert.equal((await del("businesses", o.businessId, b, adminCookie)).status, 403);
    assert.equal((await del("businesses", o.businessId, b, o.cookie)).status, 403);
    assert.equal((await del("businesses", o.businessId, b, null)).status, 401);
    assert.ok(await Business.exists({ _id: o.businessId }));
    assert.ok(await User.exists({ _id: o.id }));
  });

  it("needs the password, a reason and the name typed exactly, and says which is wrong", async () => {
    const o = await owner();
    const wrongPassword = await del("businesses", o.businessId, body(o.businessName, { password: "NotMyPassword1" }));
    assert.equal(wrongPassword.status, 422);
    assert.ok(wrongPassword.json.error.fields.password);
    const wrongName = await del("businesses", o.businessId, body("Some other name"));
    assert.equal(wrongName.status, 422);
    assert.ok(wrongName.json.error.fields.confirm);
    const noReason = await del("businesses", o.businessId, { password: sup.password, confirm: o.businessName });
    assert.equal(noReason.status, 422);
    assert.ok(noReason.json.error.fields.reason);
    assert.equal((await del("businesses", o.businessId, { ...body(o.businessName), extra: 1 })).status, 422, "no unknown fields");
    assert.ok(await Business.exists({ _id: o.businessId }), "nothing was deleted by any of those");
    assert.equal((await del("businesses", "not-an-id", body("x"))).status, 404);
    assert.equal((await del("businesses", "6ad000e48a56697a85b10e99", body("x"))).status, 404);
  });
});

describe("deleting an owner", () => {
  it("removes the account and everything of theirs, the files too, keeps the accountability trail, and emails them", async () => {
    const o = await owner();
    const opp = await openOpportunity("Grant for deletion");
    const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: opp, message: "Please.", submit: true, consent: { summary: true } } });
    assert.equal(app.status, 201, JSON.stringify(app.json));
    const form = new FormData();
    form.set("kind", "Other");
    form.set("file", new Blob([png()], { type: "image/png" }), "x.png");
    const up = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
    assert.equal(up.status, 201);
    const product = await call("POST", "/api/products", { cookie: o.cookie, body: { kind: "Product", name: "Bucket" } });
    const imgForm = new FormData();
    imgForm.set("file", new Blob([png()], { type: "image/png" }), "p.png");
    assert.equal((await fetch(`${ctx.base}/api/products/${product.json.product.id}/images`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: imgForm })).status, 201);
    await Payment.create({ user: o.id, reference: `NMREG-TEST${Date.now()}`, amountKobo: 100000 });
    const filesBefore = fs.readdirSync(dir, { recursive: true }).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).length;
    assert.ok(filesBefore >= 2);

    mails.sent = [];
    const res = await del("businesses", o.businessId, body(o.businessName));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.deleted.kind, "business");
    assert.equal(res.json.deleted.applications, 1);
    assert.equal(res.json.deleted.documents, 1);
    assert.equal(res.json.deleted.products, 1);

    assert.equal(await User.countDocuments({ _id: o.id }), 0);
    assert.equal(await Business.countDocuments({ _id: o.businessId }), 0);
    assert.equal(await Application.countDocuments({ owner: o.id }), 0);
    assert.equal(await Document.countDocuments({ owner: o.id }), 0);
    assert.equal(await Product.countDocuments({ owner: o.id }), 0);
    assert.equal(await Session.countDocuments({ user: o.id }), 0);
    const filesAfter = fs.readdirSync(dir, { recursive: true }).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).length;
    assert.equal(filesAfter, filesBefore - 2, "the document and the picture are gone from the disk");
    const consent = await ConsentRecord.findOne({ owner: o.id });
    assert.ok(consent?.revokedAt, "the consent record is kept, ended");
    assert.equal(await Payment.countDocuments({ user: o.id }), 1, "payment records are kept for accounting");

    // They cannot sign in or use the old session, and they were told.
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie })).status, 401);
    assert.ok(mails.sent.some((m) => m.to === o.email && /deleted/i.test(m.subject)));

    const entry = await AuditLog.findOne({ action: "permanent.business" }).sort({ at: -1 });
    assert.match(entry.summary, /Permanently deleted the business/);
    assert.match(entry.summary, /Requested by the owner/);
    assert.ok(!entry.summary.includes(o.email), "no personal data in the log");
    assert.equal(entry.actorName.length > 0, true);
  });
});

describe("deleting an opportunity with applications", () => {
  it("takes the applications and training records with it, and ends the consents", async () => {
    const a = await owner();
    const b = await owner();
    const opp = await openOpportunity("Grant with applicants");
    for (const o of [a, b]) assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: opp, message: "Please.", submit: true, consent: { summary: true } } })).status, 201);
    assert.equal(await Application.countDocuments({ opportunity: opp }), 2);

    // The ordinary delete still refuses, as before.
    assert.equal((await call("DELETE", `/api/admin/opportunities/${opp}`, { cookie: supCookie })).status, 409);

    assert.equal((await del("opportunities", opp, body("Wrong title"))).status, 422);
    const res = await del("opportunities", opp, body("Grant with applicants"));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.deleted.applications, 2);
    assert.equal(await Opportunity.countDocuments({ _id: opp }), 0);
    assert.equal(await Application.countDocuments({ opportunity: opp }), 0);
    const consents = await ConsentRecord.find({ opportunity: opp });
    assert.equal(consents.length, 2);
    assert.ok(consents.every((c) => c.revokedAt), "consents are ended and kept");
    assert.ok(await User.exists({ _id: a.id }), "the applicants themselves are untouched");
  });
});

describe("deleting an organisation", () => {
  it("removes it and its logins, but refuses while it still has opportunities", async () => {
    const org = await call("POST", "/api/admin/organisations", { cookie: supCookie, body: { name: `Delete me ${Date.now()}`, type: "Bank" } });
    const id = org.json.organisation.id;
    const login = await call("POST", `/api/admin/organisations/${id}/users`, { cookie: supCookie, body: { fullName: "Pat Partner", email: `pat${Date.now()}@example.com`, phone: "08011112222" } });
    assert.equal(login.status, 201, JSON.stringify(login.json));
    await Opportunity.create({ title: "Bank loan", provider: "Bank", type: "Loan", description: "A loan.", organisation: id, status: "Draft", createdBy: sup.user._id });
    const name = org.json.organisation.name;

    const blocked = await del("organisations", id, body(name));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "has_opportunities");
    await Opportunity.deleteMany({ organisation: id });

    const res = await del("organisations", id, body(name));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.deleted.logins, 1);
    assert.equal(await Organisation.countDocuments({ _id: id }), 0);
    assert.equal(await User.countDocuments({ organisation: id }), 0);
  });
});

describe("deleting staff, agents, applications and messages", () => {
  it("deletes an admin or another super admin, but never yourself", async () => {
    const extra = await createStaff({ role: "admin" });
    const mine = await del("admins", sup.user._id, body(sup.email));
    assert.equal(mine.status, 409);
    assert.equal(mine.json.error.code, "cannot_delete_self");

    const target = await User.findOne({ email: extra.email });
    assert.equal((await del("admins", target._id, body("someone@else.test"))).status, 422);
    const res = await del("admins", target._id, body(extra.email));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await User.countDocuments({ _id: target._id }), 0);
    assert.equal((await del("admins", (await User.findOne({ email: admin.email }))._id, body("x"))).status, 422);

    // An owner is not a staff account.
    const o = await owner();
    assert.equal((await del("admins", o.id, body(o.email))).status, 404);

    // Another super admin can be removed: the one doing it always remains.
    const second = await createStaff({ role: "super_admin" });
    const removed = await del("admins", second.user._id, body(second.email));
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.ok(await User.exists({ _id: sup.user._id }));
  });

  it("deletes a referral agent and keeps the code on the businesses it brought", async () => {
    const agent = await call("POST", "/api/admin/agents", { cookie: supCookie, body: { fullName: "Foot Soldier", phone: "08012345678" } });
    assert.equal(agent.status, 201, JSON.stringify(agent.json));
    const code = agent.json.agent.code;
    const reg = registrationBody();
    const o = await call("POST", "/api/auth/register", { body: { ...reg, referralCode: code } });
    assert.equal(o.status, 201, JSON.stringify(o.json));
    const res = await del("agents", agent.json.agent.id, body(code));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.deleted.businessesDetached, 1);
    assert.equal(await Agent.countDocuments({ code }), 0);
    const business = await Business.findOne({ owner: o.json.user.id });
    assert.equal(business.referral.code, code, "the code stays as text");
    assert.equal(business.referral.agent, null);
  });

  it("deletes one application with its training record, and one message with its copies", async () => {
    const o = await owner();
    const opp = await openOpportunity("Grant for one application");
    const app = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: opp, message: "Please.", submit: true, consent: { summary: true } } });
    const id = app.json.application.id;
    await TrainingRecord.create({ application: id, opportunity: opp, business: o.businessId, owner: o.id });
    const stored = await Application.findById(id);
    const name = stored.snapshot?.businessName || "DELETE";
    assert.equal((await del("applications", id, body("wrong"))).status, 422);
    const gone = await del("applications", id, body(name));
    assert.equal(gone.status, 200, JSON.stringify(gone.json));
    assert.equal(await Application.countDocuments({ _id: id }), 0);
    assert.equal(await TrainingRecord.countDocuments({ application: id }), 0);
    assert.ok(await Opportunity.exists({ _id: opp }), "the opportunity stays");

    const sent = await call("POST", "/api/admin/broadcasts", { cookie: supCookie, body: { title: "Sent in error", body: "", link: "", sendEmail: false, audience: { states: [], sectors: [], verificationStatuses: [] } } });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    const bid = sent.json.broadcast.id;
    assert.ok((await Notification.countDocuments({ broadcast: bid })) > 0);
    const removed = await del("broadcasts", bid, body("Sent in error"));
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(await Broadcast.countDocuments({ _id: bid }), 0);
    assert.equal(await Notification.countDocuments({ broadcast: bid }), 0, "the copies in owners' lists go too");
  });
});

describe("the activity log cannot be deleted", () => {
  it("has no delete route for it, and every permanent delete is recorded", async () => {
    assert.equal((await call("DELETE", "/api/admin/audit", { cookie: supCookie })).status, 404);
    assert.equal((await del("audit", "6ad000e48a56697a85b10e99", body("x"))).status, 404);
    assert.ok((await AuditLog.countDocuments({ action: /^permanent\./ })) >= 5);
  });
});
