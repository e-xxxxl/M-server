import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { Business } from "../src/models/Business.js";
import { User } from "../src/models/User.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The owner's photo, other owners or directors, impact figures, and partners narrowing applicants by what they shared.

let ctx;
let call;
let dir;
let superCookie;
let adminCookie;
const key = crypto.randomBytes(32).toString("base64");
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(60)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-photo-"));
  ctx = await startTestServer({ VERIFICATION_HASH_KEY: "h".repeat(40), RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
  const boss = await createStaff({ role: "super_admin" });
  superCookie = (await logIn(call, boss.email, boss.password)).cookie;
  const a = await createStaff({ role: "admin" });
  adminCookie = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  setDocumentStorage(undefined);
  await ctx.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, res.text);
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}
async function putPhoto(o, bytes, type = "image/png") {
  const form = new FormData();
  if (bytes !== null) form.set("file", new Blob([bytes], { type }), "me.png");
  const res = await fetch(`${ctx.base}/api/business/photo`, { method: "PUT", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const fetchPath = (urlPath, cookie) => fetch(ctx.base + urlPath, { headers: { Origin: ORIGIN, Cookie: cookie } });

describe("the owner's photo", () => {
  it("is stored privately, served to the owner, and shown to staff only when they may see personal details", async () => {
    const o = await owner();
    const bytes = png();
    const up = await putPhoto(o, bytes);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.deepEqual(up.json.business.photo, { mime: "image/png", size: bytes.length });
    const mine = await fetchPath("/api/business/photo", o.cookie);
    assert.equal(mine.status, 200);
    assert.deepEqual(Buffer.from(await mine.arrayBuffer()), bytes);
    assert.equal((await fetchPath(`/api/admin/businesses/${o.businessId}/photo`, adminCookie)).status, 200);

    // A staff member who may not see personal details cannot open the photo.
    const blind = await createStaff({ role: "admin" });
    await User.updateOne({ _id: blind.user._id }, { permissionsCustom: true, permissions: ["verify"] });
    const blindCookie = (await logIn(call, blind.email, blind.password)).cookie;
    assert.equal((await fetchPath(`/api/admin/businesses/${o.businessId}/photo`, blindCookie)).status, 403);
    const other = await owner();
    assert.ok([401, 403].includes((await fetchPath(`/api/admin/businesses/${o.businessId}/photo`, other.cookie)).status));
    assert.equal((await fetchPath("/api/business/photo", other.cookie)).status, 404, "another owner has no photo");
  });

  it("replaces and removes the photo, and refuses anything but a JPEG or PNG", async () => {
    const o = await owner();
    assert.equal((await putPhoto(o, png())).status, 200);
    assert.equal((await putPhoto(o, Buffer.from("%PDF-1.4 not a picture"), "application/pdf")).status, 422);
    assert.equal((await putPhoto(o, null)).status, 422);
    const del = await fetch(`${ctx.base}/api/business/photo`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: o.cookie } });
    assert.equal(del.status, 204);
    assert.equal((await call("GET", "/api/business", { cookie: o.cookie })).json.business.photo, null);
  });
});

describe("other owners or directors", () => {
  const person = (over = {}) => ({ fullName: "Chika Eze", role: "Director", phone: "08023456789", email: "chika@example.com", nin: "11122233344", consent: true, ...over });

  it("up to two can be added, each with their own NIN of which only the last four digits are kept", async () => {
    const o = await owner();
    const first = await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person() });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.coOwners[0].ninMasked, "*******3344");
    assert.equal(first.json.max, 2);
    const second = await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ fullName: "Tunde Bello", nin: "55566677788", email: "tunde@example.com" }) });
    assert.equal(second.status, 201);
    assert.equal(second.json.coOwners.length, 2);
    const third = await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ fullName: "Third Person", nin: "99988877766" }) });
    assert.equal(third.status, 422, "only two besides the main owner");

    const stored = JSON.stringify(await Business.findById(o.businessId).lean());
    assert.ok(!stored.includes("11122233344") && !stored.includes("55566677788"), "the NIN itself is never stored");
    const shown = JSON.stringify((await call("GET", "/api/business", { cookie: o.cookie })).json);
    assert.ok(!shown.includes("ninHash"), "the fingerprint is never returned");
    assert.equal((await call("GET", "/api/business/co-owners", { cookie: o.cookie })).json.coOwners.length, 2);
  });

  it("needs the person's consent, a real NIN, and refuses the same NIN twice in one business", async () => {
    const o = await owner();
    assert.equal((await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ consent: false }) })).status, 422);
    assert.equal((await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ nin: "123" }) })).status, 422);
    assert.equal((await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ role: "Janitor" }) })).status, 422);
    assert.equal((await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: { ...person(), extra: 1 } })).status, 422);
    assert.equal((await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person() })).status, 201);
    const dup = await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person({ fullName: "Someone Else", email: "else@example.com" }) });
    assert.equal(dup.status, 422);
    assert.match(dup.json.error.fields.nin, /already used/);
  });

  it("can be changed and removed, only by the business owner", async () => {
    const o = await owner();
    const added = await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person() });
    const id = added.json.coOwners[0].id;
    const changed = await call("PATCH", `/api/business/co-owners/${id}`, { cookie: o.cookie, body: { fullName: "Chika Okeke", phone: "08099998888" } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.coOwners[0].fullName, "Chika Okeke");
    assert.equal(changed.json.coOwners[0].ninMasked, "*******3344", "the NIN is unchanged unless a new one is sent");
    assert.equal((await call("PATCH", `/api/business/co-owners/${id}`, { cookie: o.cookie, body: { nin: "22233344455" } })).status, 422, "a new NIN needs consent");
    const renewed = await call("PATCH", `/api/business/co-owners/${id}`, { cookie: o.cookie, body: { nin: "22233344455", consent: true } });
    assert.equal(renewed.json.coOwners[0].ninMasked, "*******4455");
    assert.equal((await call("PATCH", `/api/business/co-owners/${id}`, { cookie: o.cookie, body: {} })).status, 422);

    const stranger = await owner();
    assert.equal((await call("PATCH", `/api/business/co-owners/${id}`, { cookie: stranger.cookie, body: { fullName: "Hijack Attempt" } })).status, 404);
    assert.equal((await call("DELETE", `/api/business/co-owners/${id}`, { cookie: stranger.cookie })).status, 404);
    const removed = await call("DELETE", `/api/business/co-owners/${id}`, { cookie: o.cookie });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.coOwners, []);
  });

  it("staff see them on the business page, with phone and email only if they may see personal details", async () => {
    const o = await owner();
    await call("POST", "/api/business/co-owners", { cookie: o.cookie, body: person() });
    const full = await call("GET", `/api/admin/businesses/${o.businessId}`, { cookie: adminCookie });
    assert.equal(full.json.business.coOwners[0].phone, "08023456789");
    assert.equal(full.json.business.coOwners[0].email, "chika@example.com");
    const blind = await createStaff({ role: "admin" });
    await User.updateOne({ _id: blind.user._id }, { permissionsCustom: true, permissions: ["verify"] });
    const blindCookie = (await logIn(call, blind.email, blind.password)).cookie;
    const hidden = await call("GET", `/api/admin/businesses/${o.businessId}`, { cookie: blindCookie });
    assert.equal(hidden.json.business.coOwners[0].fullName, "Chika Eze");
    assert.equal(hidden.json.business.coOwners[0].phone, "");
    assert.equal(hidden.json.business.coOwners[0].email, "");
  });
});

describe("impact", () => {
  const thisYear = new Date().getFullYear();

  it("an owner reports the jobs created each year and can correct the figure", async () => {
    const o = await owner();
    const put = await call("PUT", `/api/impact/${thisYear}`, { cookie: o.cookie, body: { jobsCreated: 12 } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.entry.jobsCreated, 12);
    assert.equal(put.json.entry.enteredBy, "owner");
    await call("PUT", `/api/impact/${thisYear}`, { cookie: o.cookie, body: { jobsCreated: 15 } });
    await call("PUT", `/api/impact/${thisYear - 1}`, { cookie: o.cookie, body: { jobsCreated: 4 } });
    const got = await call("GET", "/api/impact", { cookie: o.cookie });
    assert.deepEqual(got.json.entries.map((e) => [e.year, e.jobsCreated]), [[thisYear, 15], [thisYear - 1, 4]]);
    assert.equal(got.json.derived.opportunitiesAccessed, 0);
    assert.equal(got.json.derived.trainingsCompleted, 0);
    for (const [year, body] of [[thisYear + 1, { jobsCreated: 1 }], [1999, { jobsCreated: 1 }], [thisYear, { jobsCreated: -1 }], [thisYear, { jobsCreated: 1.5 }], [thisYear, { jobsCreated: 1, extra: 1 }], ["abc", { jobsCreated: 1 }]]) {
      assert.equal((await call("PUT", `/api/impact/${year}`, { cookie: o.cookie, body })).status, 422, `${year} ${JSON.stringify(body)}`);
    }
    assert.equal((await call("GET", "/api/impact")).status, 401);
  });

  it("the super admin can enter a figure for a business, an ordinary admin cannot, and it is logged", async () => {
    const o = await owner();
    const res = await call("PUT", `/api/admin/businesses/${o.businessId}/impact/${thisYear}`, { cookie: superCookie, body: { jobsCreated: 30 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.entry.enteredBy, "admin");
    assert.equal((await call("PUT", `/api/admin/businesses/${o.businessId}/impact/${thisYear}`, { cookie: adminCookie, body: { jobsCreated: 99 } })).status, 403);
    const detail = await call("GET", `/api/admin/businesses/${o.businessId}`, { cookie: adminCookie });
    assert.equal(detail.json.impact.entries[0].jobsCreated, 30);
    assert.ok("opportunitiesAccessed" in detail.json.impact.derived);
    const mine = await call("GET", "/api/impact", { cookie: o.cookie });
    assert.equal(mine.json.entries[0].enteredBy, "admin", "the owner can see who entered the figure");
  });

  it("a business that gets a CAC number after joining counts as formalised, one that had it at sign-up does not", async () => {
    const late = await owner({ hasCac: "No", cacNumber: "" });
    const before = await call("GET", "/api/admin/reports", { cookie: adminCookie });
    const early = await owner({ hasCac: "Yes", cacNumber: "RC1234567" });
    const mid = await call("GET", "/api/admin/reports", { cookie: adminCookie });
    assert.equal(mid.json.impact.businessesFormalised, before.json.impact.businessesFormalised, "having a CAC at sign-up is not formalising");
    const patched = await call("PATCH", "/api/business", { cookie: late.cookie, body: { hasCac: "Yes", cacNumber: "RC7654321" } });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    const after = await call("GET", "/api/admin/reports", { cookie: adminCookie });
    assert.equal(after.json.impact.businessesFormalised, before.json.impact.businessesFormalised + 1);
    const again = await call("PATCH", "/api/business", { cookie: late.cookie, body: { cacNumber: "RC1112223" } });
    assert.equal(again.status, 200);
    assert.equal((await call("GET", "/api/admin/reports", { cookie: adminCookie })).json.impact.businessesFormalised, after.json.impact.businessesFormalised, "counted once");
    void early;
  });

  it("the admin reports total the jobs and the platform counts, and name no business", async () => {
    const o = await owner();
    await call("PUT", `/api/impact/${thisYear}`, { cookie: o.cookie, body: { jobsCreated: 7 } });
    const reports = await call("GET", "/api/admin/reports", { cookie: adminCookie });
    const impact = reports.json.impact;
    assert.ok(impact.jobsCreatedTotal >= 7);
    assert.ok(impact.jobsCreatedByYear.some((r) => r.year === thisYear && r.jobsCreated >= 7));
    for (const k of ["opportunitiesAccessed", "programmeAttendees", "programmeCompleted", "certificatesIssued", "businessesFormalised"]) assert.equal(typeof impact[k], "number", k);
    assert.ok(!JSON.stringify(impact).includes("Business"), "no business is named");
  });
});
