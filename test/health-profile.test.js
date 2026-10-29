import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildHealthProfile, walletChecklist } from "../src/lib/health-profile.js";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The health profile is a checklist of plain facts. These tests keep it that way: counts, never a score.

let ctx;
let call;
let dir;
let admin;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-health-"));
  ctx = await startTestServer();
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: crypto.randomBytes(32).toString("base64") }));
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}

const area = (hp, id) => hp.areas.find((a) => a.id === id);
const item = (hp, areaId, itemId) => area(hp, areaId).items.find((i) => i.id === itemId);

async function addDocument(o, kind) {
  const form = new FormData();
  form.set("kind", kind);
  form.set("file", new Blob([Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(30)])], { type: "application/pdf" }), "x.pdf");
  const res = await fetch(`${ctx.base}/api/documents`, { method: "POST", headers: { Origin: ORIGIN, Cookie: o.cookie }, body: form });
  assert.equal(res.status, 201);
}

describe("the health profile", () => {
  it("lists four areas with counts and statuses in words, and never a score, percentage or grade", async () => {
    const o = await owner();
    const res = await call("GET", "/api/health-profile", { cookie: o.cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.areas.map((a) => a.id), ["registration", "verification", "information", "documents"]);
    assert.match(res.json.note, /not a score or a grade/);
    for (const a of res.json.areas) {
      assert.equal(a.summary, `${a.done} of ${a.total}`);
      assert.ok(["Complete", "In progress", "To do"].includes(a.status));
    }
    const text = JSON.stringify(res.json).toLowerCase();
    for (const forbidden of ['"score"', "percent", "%", "grade", "rating", "needs attention", '"rank"', "weight"]) {
      assert.ok(!text.replace(/not a score or a grade/g, "").includes(forbidden), `no ${forbidden}`);
    }
  });

  it("reflects the profile: registration, information and the digital presence change as details are added", async () => {
    const o = await owner({ businessType: "Not yet registered with the CAC", cacNumber: "", tin: "" });
    const before = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(item(before, "registration", "registered").done, false);
    assert.equal(item(before, "registration", "cac").done, false);
    assert.equal(item(before, "registration", "tin").done, false);
    assert.equal(item(before, "information", "digital").done, false);
    assert.equal(item(before, "information", "financial").detail, "2 of 4 details", "the revenue band and the loans answer are filled at registration; bank and funding need are not");
    assert.equal(item(before, "information", "identity").done, true);
    assert.equal(item(before, "information", "location").done, true);

    const patch = await call("PATCH", "/api/business", { cookie: o.cookie, body: { businessType: "Private limited company", hasCac: "Yes", cacNumber: "RC123456", hasTin: "Yes", tin: "12345678-0001", website: "example.com", bankName: "Example Bank", fundingNeeds: "1 to 5 million naira", branches: 2 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.json));
    const after = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    for (const id of ["registered", "cac", "tin"]) assert.equal(item(after, "registration", id).done, true, id);
    assert.equal(area(after, "registration").status, "Complete");
    assert.equal(item(after, "information", "digital").done, true);
    assert.equal(item(after, "information", "financial").done, true);
    assert.equal(item(after, "information", "operations").done, true);
    assert.ok(area(after, "information").done > area(before, "information").done);
  });

  it("shows the verification status in words, and Verified once staff verify", async () => {
    const o = await owner();
    let hp = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(hp.verificationStatus, "Unverified");
    assert.equal(item(hp, "verification", "verified").done, false);
    assert.equal(item(hp, "verification", "verified").detail, "Unverified");
    assert.equal(item(hp, "verification", "nmrepId").done, false);
    const set = await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "Checked." } });
    assert.equal(set.status, 200);
    hp = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(item(hp, "verification", "verified").done, true);
    assert.equal(item(hp, "verification", "nmrepId").done, true);
    assert.equal(area(hp, "verification").status, "Complete");
  });

  it("marks each of the framework's wallet documents as present when it is uploaded", async () => {
    const o = await owner();
    let hp = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(area(hp, "documents").done, 0);
    assert.equal(area(hp, "documents").total, 10);
    assert.equal(area(hp, "documents").status, "To do");
    await addDocument(o, "CAC Certificate");
    await addDocument(o, "Other");
    hp = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(item(hp, "documents", "cac-certificate").done, true);
    assert.equal(area(hp, "documents").done, 1, "'Other' is not one of the six");
    assert.equal(area(hp, "documents").status, "In progress");
    assert.deepEqual(item(hp, "documents", "tax-clearance").link, { screen: "documents" });
  });

  it("suggests at most five things not yet done, with where to do them", async () => {
    const o = await owner();
    const hp = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.ok(hp.nextSteps.length > 0 && hp.nextSteps.length <= 5);
    for (const s of hp.nextSteps) {
      assert.ok(s.label && s.hint && s.area);
      assert.ok(s.link === null || ["profile", "documents"].includes(s.link.screen));
    }
    assert.ok(hp.nextSteps.every((s, i, all) => all.findIndex((x) => x.label === s.label) === i), "no repeats");
  });

  it("is for business owners only", async () => {
    const o = await owner();
    assert.equal((await call("GET", "/api/health-profile")).status, 401);
    assert.equal((await call("GET", "/api/health-profile", { cookie: admin })).status, 403);
    assert.equal((await call("GET", "/api/health-profile", { cookie: o.cookie })).status, 200);
  });

  it("treats a complete business as complete everywhere it can, without inventing anything", () => {
    const hp = buildHealthProfile(
      {
        businessName: "A", businessType: "Private limited company", sector: "S", industry: "I", yearEstablished: 2019, cacNumber: "RC1", tin: "T1",
        state: "Lagos", lga: "L", city: "C", address: "A", ownerName: "O", ownerRole: "R", ownershipStructure: "Sole owner", employees: 3, branches: 0,
        annualRevenue: "R", existingLoans: "No", bankName: "B", fundingNeeds: "F", website: "w.com", verificationStatus: "Verified", nmrepId: "NMREP-2026-000001",
      },
      walletChecklist,
    );
    assert.ok(hp.areas.every((a) => a.status === "Complete" && a.done === a.total));
    assert.deepEqual(hp.nextSteps, []);
  });
});
