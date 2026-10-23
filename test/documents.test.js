import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { sniffMime } from "../src/lib/documents.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Document } from "../src/models/Document.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The document wallet: private encrypted storage, uploads checked by their first bytes, limits, and sharing a document
// with an organisation only for one application and only while the owner's agreement is active.

let ctx;
let call;
let admin;
let dir;
const key = crypto.randomBytes(32).toString("base64");
let counter = 0;

// Small but real files: the first bytes decide the kind, so these are enough to be accepted.
const pdf = (text = "contract") => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`${text}-${crypto.randomUUID()}\n%%EOF`)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-docs-"));
  ctx = await startTestServer({ DOCUMENT_MAX_MB: "1", DOCUMENT_MAX_FILES: "5", DOCUMENT_MAX_TOTAL_MB: "3" });
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner(account = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ account }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id };
}

/** Uploads like a browser or the app: multipart form data with the parts file, kind and title. */
async function upload(o, { bytes = pdf(), kind = "CAC Certificate", title, type = "application/pdf", name = "scan.pdf", fields = {} } = {}) {
  const form = new FormData();
  if (kind !== null) form.set("kind", kind);
  if (title !== undefined) form.set("title", title);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (bytes !== null) form.set("file", new Blob([bytes], { type }), name);
  const res = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, ...(o ? { Cookie: o.cookie } : {}) }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const download = (path, cookie) => fetch(ctx.base + path, { headers: { Origin: ORIGIN, Cookie: cookie } });

async function partner() {
  counter += 1;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Wallet Bank ${counter} ${Date.now()}`, type: "Bank" } });
  const email = `wallet${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, { cookie: admin, body: { fullName: "Pat Partner", email, phone: "08011112222" } });
  const login = await logIn(call, email, created.json.temporaryPassword);
  await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "PartnerPass1" } });
  return { cookie: login.cookie, name: org.json.organisation.name };
}

async function openOpportunity(p) {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { title: "Wallet programme", type: "Grant", description: "A programme." } });
  const id = c.json.opportunity.id;
  await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
  await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin });
  return id;
}

const apply = (o, opportunityId, extra = {}) =>
  call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId, message: "Please consider us.", submit: true, consent: { summary: true, documents: true }, ...extra } });

describe("storage", () => {
  it("encrypts on the way in, decrypts on the way out, and refuses anything that is not its own random name", async () => {
    const storage = createDocumentStorage({ dir: path.join(dir, "unit"), encryptionKey: key });
    const secret = Buffer.from("A very private bank statement");
    const saved = await storage.save(secret);
    const onDisk = fs.readFileSync(path.join(dir, "unit", saved.storageKey.slice(0, 2), saved.storageKey));
    assert.ok(!onDisk.includes(secret), "the file on disk is not readable");
    assert.deepEqual(await storage.read(saved), secret);

    const other = createDocumentStorage({ dir: path.join(dir, "unit"), encryptionKey: crypto.randomBytes(32).toString("base64") });
    await assert.rejects(() => other.read(saved), "another key cannot read it");
    onDisk[0] ^= 0xff;
    fs.writeFileSync(path.join(dir, "unit", saved.storageKey.slice(0, 2), saved.storageKey), onDisk);
    await assert.rejects(() => storage.read(saved), "an altered file is refused, not returned");

    for (const bad of ["../../etc/passwd", "a".repeat(31), "G".repeat(32), "", "a/../b"]) await assert.rejects(() => storage.read({ storageKey: bad, iv: "00", tag: "00" }), `refused: ${bad}`);
    await storage.remove(saved.storageKey);
    await storage.remove(saved.storageKey); // already gone is not an error
    assert.equal(createDocumentStorage({ dir, encryptionKey: "short" }).enabled, false);
    assert.equal(createDocumentStorage({ dir, encryptionKey: "" }).enabled, false);
  });

  it("recognises a PDF, a JPEG and a PNG by their first bytes only", () => {
    assert.equal(sniffMime(pdf()), "application/pdf");
    assert.equal(sniffMime(jpeg()), "image/jpeg");
    assert.equal(sniffMime(png()), "image/png");
    assert.equal(sniffMime(Buffer.from("<html><script>alert(1)</script>")), null);
    assert.equal(sniffMime(Buffer.from("MZ\x90\x00 an executable")), null);
    assert.equal(sniffMime(Buffer.from("%PDF")), null, "too short to be a PDF header");
    assert.equal(sniffMime(Buffer.alloc(0)), null);
  });
});

describe("the owner's wallet", () => {
  it("is off, with a plain message, when no key is configured", async () => {
    const o = await owner();
    setDocumentStorage(createDocumentStorage(null));
    try {
      const list = await call("GET", "/api/documents", { cookie: o.cookie });
      assert.equal(list.json.available, false);
      const res = await upload(o);
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, "documents_unavailable");
    } finally {
      setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
    }
  });

  it("stores a file encrypted, never shows storage details, and gives back exactly the same bytes as a safe download", async () => {
    const o = await owner();
    const bytes = pdf("cac certificate");
    const res = await upload(o, { bytes, kind: "CAC Certificate", title: "My CAC certificate", name: "../../evil.exe" });
    assert.equal(res.status, 201, res.text);
    const doc = res.json.document;
    assert.equal(doc.kind, "CAC Certificate");
    assert.equal(doc.title, "My CAC certificate");
    assert.equal(doc.mime, "application/pdf");
    assert.equal(doc.size, bytes.length);
    assert.equal(doc.sensitive, false);
    assert.deepEqual(doc.sharedWith, []);
    for (const hidden of ["storageKey", "iv", "tag", "sha256", "owner", "business"]) assert.ok(!(hidden in doc), `not returned: ${hidden}`);
    assert.ok(!res.text.includes("evil"), "the client's file name is not echoed");

    const stored = await Document.findById(doc.id);
    const onDisk = fs.readFileSync(path.join(dir, stored.storageKey.slice(0, 2), stored.storageKey));
    assert.ok(!onDisk.includes(Buffer.from("cac certificate")), "plain text is not on the disk");
    assert.ok(!JSON.stringify(stored.toObject()).includes("evil.exe"), "the client's file name is never kept");

    const file = await download(`/api/documents/${doc.id}/file`, o.cookie);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal(file.headers.get("cache-control"), "no-store");
    assert.match(file.headers.get("content-disposition"), /^attachment; filename="My-CAC-certificate\.pdf"$/);
  });

  it("decides the type from the content: a script named .pdf is refused, a PNG with a wrong name is accepted", async () => {
    const o = await owner();
    const script = await upload(o, { bytes: Buffer.from("<script>alert(1)</script>"), name: "invoice.pdf", type: "application/pdf" });
    assert.equal(script.status, 422);
    assert.equal(script.json.error.code, "unsupported_file");
    assert.ok(script.json.error.fields.file);
    const exe = await upload(o, { bytes: Buffer.from("MZ\x90\x00 not safe"), name: "scan.png", type: "image/png" });
    assert.equal(exe.status, 422);
    const image = await upload(o, { bytes: png(), name: "photo.txt", type: "text/plain", kind: "Business Licence" });
    assert.equal(image.status, 201);
    assert.equal(image.json.document.mime, "image/png");
    const picture = await upload(o, { bytes: jpeg(), name: "photo", type: "application/octet-stream", kind: "Other" });
    assert.equal(picture.json.document.mime, "image/jpeg");
    assert.match((await download(`/api/documents/${picture.json.document.id}/file`, o.cookie)).headers.get("content-disposition"), /\.jpg"$/);
  });

  it("validates the kind and the file, flags sensitive kinds, and defaults the title to the kind", async () => {
    const o = await owner();
    assert.equal((await upload(o, { kind: "Passport" })).json.error.fields.kind, "Choose one of the listed options.");
    assert.ok((await upload(o, { kind: null })).json.error.fields.kind);
    assert.equal((await upload(o, { bytes: null })).json.error.fields.file, "Choose a file.");
    assert.equal((await upload(o, { bytes: Buffer.alloc(0) })).json.error.fields.file, "This file is empty.");
    assert.equal((await upload(o, { title: "x".repeat(101) })).status, 422);
    assert.equal((await upload(o, { fields: { price: "5" } })).status, 422, "unknown part");
    const id = await upload(o, { kind: "ID" });
    assert.equal(id.json.document.title, "ID");
    assert.equal(id.json.document.sensitive, true);
    assert.equal((await upload(o, { kind: "Bank Statement", title: "March" })).json.document.sensitive, true);
    const notMultipart = await call("POST", "/api/documents", { cookie: o.cookie, body: { kind: "ID" } });
    assert.equal(notMultipart.status, 415);
    assert.equal(notMultipart.json.error.code, "unsupported_media");
  });

  it("refuses a file over the size limit before keeping any of it, and enforces the count and the total", async () => {
    const o = await owner();
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(1024 * 1024 + 10)]);
    const res = await upload(o, { bytes: big });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, "file_too_large");
    assert.match(res.json.error.message, /limit is 1 MB/);
    assert.equal(await Document.countDocuments({ owner: o.id }), 0);

    // Five files are allowed (DOCUMENT_MAX_FILES=5), the sixth is not.
    for (let i = 0; i < 5; i++) assert.equal((await upload(o, { title: `File ${i}` })).status, 201);
    const sixth = await upload(o, { title: "Sixth" });
    assert.equal(sixth.status, 422);
    assert.equal(sixth.json.error.code, "document_limit");

    // The total is capped too (3 MB here): three near-1 MB files fit, a fourth does not.
    const p = await owner();
    const almost = () => Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(900 * 1024)]);
    for (let i = 0; i < 3; i++) assert.equal((await upload(p, { bytes: almost() })).status, 201);
    const over = await upload(p, { bytes: almost() });
    assert.equal(over.status, 422);
    assert.match(over.json.error.message, /over 3 MB in total/);
  });

  it("lists only the owner's own documents, and nobody else can open or delete them", async () => {
    const a = await owner();
    const b = await owner();
    const doc = (await upload(a)).json.document;
    const list = await call("GET", "/api/documents", { cookie: a.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items.map((d) => d.id), [doc.id]);
    assert.equal(list.json.available, true);
    assert.deepEqual(list.json.limits, { maxFileMb: 1, maxFiles: 5, maxTotalMb: 3, types: ["PDF", "JPEG", "PNG"] });
    assert.ok(list.json.kinds.some((k) => k.kind === "ID" && k.sensitive));
    assert.deepEqual((await call("GET", "/api/documents", { cookie: b.cookie })).json.items, []);
    assert.equal((await download(`/api/documents/${doc.id}/file`, b.cookie)).status, 404);
    assert.equal((await call("DELETE", `/api/documents/${doc.id}`, { cookie: b.cookie })).status, 404);
    assert.equal((await call("GET", "/api/documents/not-an-id/file", { cookie: a.cookie })).status, 404);
    assert.equal(await Document.countDocuments({ _id: doc.id }), 1);

    const p = await partner();
    for (const [method, path] of [["GET", "/api/documents"], ["GET", `/api/documents/${doc.id}/file`], ["DELETE", `/api/documents/${doc.id}`]]) {
      assert.equal((await call(method, path)).status, 401, `anonymous ${method} ${path}`);
      assert.equal((await call(method, path, { cookie: p.cookie })).status, 403, `partner ${path}`);
      assert.equal((await call(method, path, { cookie: admin })).status, 403, `admin ${path}`);
    }
    assert.equal((await upload(null)).status, 401);
    assert.equal((await upload({ cookie: p.cookie })).status, 403);
  });

  it("a file that has been changed on the disk is never handed out", async () => {
    const o = await owner();
    const doc = (await upload(o)).json.document;
    const stored = await Document.findById(doc.id);
    const file = path.join(dir, stored.storageKey.slice(0, 2), stored.storageKey);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(file, bytes);
    assert.equal((await download(`/api/documents/${doc.id}/file`, o.cookie)).status, 404);
  });
});

describe("sharing with an organisation", () => {
  it("attaches chosen documents only with consent, only from the owner's own wallet, and shows the organisation just those", async () => {
    const p = await partner();
    const opportunity = await openOpportunity(p);
    const o = await owner();
    const shared = (await upload(o, { kind: "CAC Certificate", title: "CAC", bytes: pdf("shared") })).json.document;
    const kept = (await upload(o, { kind: "Bank Statement", title: "Statement", bytes: pdf("kept private") })).json.document;
    const stranger = await owner();
    const foreign = (await upload(stranger)).json.document;

    // Refused: documents without the tick, the tick without documents, someone else's document.
    const noTick = await apply(o, opportunity, { consent: { summary: true }, documentIds: [shared.id] });
    assert.equal(noTick.status, 422);
    assert.equal(noTick.json.error.code, "consent_required");
    assert.ok(noTick.json.error.fields["consent.documents"]);
    const emptyTick = await apply(o, opportunity, { documentIds: [] });
    assert.equal(emptyTick.status, 422);
    assert.ok(emptyTick.json.error.fields.documentIds);
    const wrongOwner = await apply(o, opportunity, { documentIds: [shared.id, foreign.id] });
    assert.equal(wrongOwner.status, 422);
    assert.ok(wrongOwner.json.error.fields["documentIds.1"]);
    assert.equal((await apply(o, opportunity, { documentIds: Array.from({ length: 11 }, () => "a".repeat(24)) })).status, 422);
    assert.equal(await Document.countDocuments({ owner: o.id }), 2, "nothing was lost");

    const done = await apply(o, opportunity, { documentIds: [shared.id, shared.id] });
    assert.equal(done.status, 201, JSON.stringify(done.json));
    assert.deepEqual(done.json.application.documents, [shared.id], "a repeated id counts once");
    const applicationId = done.json.application.id;

    // The partner sees which documents were shared, never the other one, and can open only the shared one.
    const detail = await call("GET", `/api/partner/applications/${applicationId}`, { cookie: p.cookie });
    assert.deepEqual(detail.json.documents.map((d) => [d.id, d.kind, d.title]), [[shared.id, "CAC Certificate", "CAC"]]);
    assert.ok(!detail.text.includes("Statement") && !detail.text.includes(kept.id));
    const file = await download(`/api/partner/applications/${applicationId}/documents/${shared.id}`, p.cookie);
    assert.equal(file.status, 200);
    assert.ok(Buffer.from(await file.arrayBuffer()).includes(Buffer.from("shared")));
    assert.equal((await download(`/api/partner/applications/${applicationId}/documents/${kept.id}`, p.cookie)).status, 404, "a document that was not shared");
    assert.equal((await download(`/api/partner/applications/${applicationId}/documents/${foreign.id}`, p.cookie)).status, 404);

    // Every download by staff is written to the audit log, with who and what, never the contents.
    const log = await AuditLog.findOne({ action: "document.download", targetId: applicationId });
    assert.ok(log);
    assert.match(log.summary, /Downloaded "CAC" \(CAC Certificate\)/);

    // NMREP staff see the same, and are logged too.
    const adminDetail = await call("GET", `/api/admin/applications/${applicationId}`, { cookie: admin });
    assert.deepEqual(adminDetail.json.documents.map((d) => d.id), [shared.id]);
    assert.equal((await download(`/api/admin/applications/${applicationId}/documents/${shared.id}`, admin)).status, 200);
    assert.equal((await download(`/api/admin/applications/${applicationId}/documents/${kept.id}`, admin)).status, 404);

    // Another organisation cannot reach it, and neither can an owner through the staff route.
    const other = await partner();
    assert.equal((await download(`/api/partner/applications/${applicationId}/documents/${shared.id}`, other.cookie)).status, 404);
    assert.equal((await download(`/api/partner/applications/${applicationId}/documents/${shared.id}`, o.cookie)).status, 403);

    // The owner sees who each document is shared with, and the agreement lists the category.
    const mine = await call("GET", "/api/documents", { cookie: o.cookie });
    const row = mine.json.items.find((d) => d.id === shared.id);
    assert.equal(row.sharedWith.length, 1);
    assert.equal(row.sharedWith[0].with, p.name);
    assert.deepEqual(mine.json.items.find((d) => d.id === kept.id).sharedWith, []);
    const consents = await call("GET", "/api/consents", { cookie: o.cookie });
    assert.deepEqual(consents.json.items[0].categories.sort(), ["documents", "summary"]);
    assert.ok(consents.json.items[0].categoryDetails.some((c) => c.key === "documents"));
  });

  it("a draft needs no documents and keeps none, and sharing nothing is the default", async () => {
    const p = await partner();
    const opportunity = await openOpportunity(p);
    const o = await owner();
    const doc = (await upload(o)).json.document;
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: opportunity, message: "Later", documentIds: [doc.id] } });
    assert.equal(draft.status, 201);
    assert.deepEqual(draft.json.application.documents, []);
    const plain = await apply(o, opportunity, { consent: { summary: true } });
    assert.equal(plain.status, 201);
    const detail = await call("GET", `/api/partner/applications/${plain.json.application.id}`, { cookie: p.cookie });
    assert.deepEqual(detail.json.documents, []);
  });

  it("sharing ends when the owner withdraws, sends a new submission without the documents, or deletes a document", async () => {
    const p = await partner();
    const opportunity = await openOpportunity(p);
    const o = await owner();
    const a = (await upload(o, { title: "A", bytes: pdf("a") })).json.document;
    const b = (await upload(o, { title: "B", bytes: pdf("b") })).json.document;
    const application = (await apply(o, opportunity, { documentIds: [a.id, b.id] })).json.application.id;
    const open = (id) => download(`/api/partner/applications/${application}/documents/${id}`, p.cookie);
    assert.equal((await open(a.id)).status, 200);
    assert.equal((await open(b.id)).status, 200);

    // Deleting one document removes it from the file, the record, the application and the agreement.
    const stored = await Document.findById(a.id);
    const aFile = path.join(dir, stored.storageKey.slice(0, 2), stored.storageKey);
    assert.ok(fs.existsSync(aFile));
    assert.equal((await call("DELETE", `/api/documents/${a.id}`, { cookie: o.cookie })).status, 204);
    assert.ok(!fs.existsSync(aFile), "the encrypted file is gone from the disk");
    assert.equal((await open(a.id)).status, 404);
    assert.equal((await open(b.id)).status, 200);
    const afterDelete = await call("GET", `/api/partner/applications/${application}`, { cookie: p.cookie });
    assert.deepEqual(afterDelete.json.documents.map((d) => d.id), [b.id]);

    // Withdrawing ends the agreement, so nothing can be opened any more.
    assert.equal((await call("POST", `/api/applications/${application}/withdraw`, { cookie: o.cookie })).status, 200);
    assert.equal((await open(b.id)).status, 404);
    assert.deepEqual((await call("GET", `/api/partner/applications/${application}`, { cookie: p.cookie })).json.documents, []);
    assert.deepEqual((await call("GET", "/api/documents", { cookie: o.cookie })).json.items[0].sharedWith, []);
    assert.equal((await download(`/api/admin/applications/${application}/documents/${b.id}`, admin)).status, 404, "staff too");

    // A new submission without documents replaces the old agreement.
    const again = await apply(o, opportunity, { consent: { summary: true } });
    assert.equal(again.status, 201);
    assert.equal((await open(b.id)).status, 404);
  });

  it("deleting the account removes every file from the disk, not only the records", async () => {
    const o = await owner();
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const doc = (await upload(o, { title: `Doc ${i}` })).json.document;
      const stored = await Document.findById(doc.id);
      keys.push(path.join(dir, stored.storageKey.slice(0, 2), stored.storageKey));
    }
    assert.ok(keys.every((f) => fs.existsSync(f)));
    const res = await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Secret123" } });
    assert.equal(res.status, 204);
    assert.ok(keys.every((f) => !fs.existsSync(f)), "no encrypted file is left behind");
    assert.equal(await Document.countDocuments({ owner: o.id }), 0);
  });
});

describe("the website can upload", () => {
  it("answers a browser's permission check for an upload, which needs no special headers", async () => {
    const res = await fetch(`${ctx.base}/api/documents`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  });
});
