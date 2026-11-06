import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { businessSizeOf } from "../src/models/Business.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Profile details that are not sensitive: a description, the size of the business, monthly revenue and assets value, a logo,
// and what the business needs help with (skill gaps), how it likes to learn and what interests it.

let ctx;
let call;
let admin;
let dir;
const key = crypto.randomBytes(32).toString("base64");

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(60)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(60)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-logo-"));
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

async function owner() {
  const res = await call("POST", "/api/auth/register", { body: registrationBody() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, businessId: res.json.business.id };
}
async function putLogo(o, bytes, type = "image/png") {
  const form = new FormData();
  if (bytes !== null) form.set("file", new Blob([bytes], { type }), "logo.png");
  const res = await fetch(`${ctx.base}/api/business/logo`, { method: "PUT", headers: { Origin: ORIGIN, ...(o ? { Cookie: o.cookie } : {}) }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const fetchPath = (urlPath, cookie) => fetch(ctx.base + urlPath, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });
const filesOnDisk = () => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : (n += 1));
  };
  walk(dir);
  return n;
};

describe("business size", () => {
  it("comes from the number of employees", () => {
    assert.equal(businessSizeOf(1), "Micro");
    assert.equal(businessSizeOf(9), "Micro");
    assert.equal(businessSizeOf(10), "Small");
    assert.equal(businessSizeOf(49), "Small");
    assert.equal(businessSizeOf(50), "Medium");
    assert.equal(businessSizeOf(199), "Medium");
    assert.equal(businessSizeOf(200), "Large");
    assert.equal(businessSizeOf(null), "Micro");
    assert.equal(businessSizeOf("x"), null);
    assert.equal(businessSizeOf(-1), null);
  });

  it("is on the profile, and follows a change in employees", async () => {
    const o = await owner();
    const first = await call("GET", "/api/business", { cookie: o.cookie });
    assert.ok(["Micro", "Small", "Medium", "Large"].includes(first.json.business.businessSize));
    const res = await call("PATCH", "/api/business", { cookie: o.cookie, body: { employees: 60 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.business.businessSize, "Medium");
  });
});

describe("the extra profile details", () => {
  it("are saved and returned", async () => {
    const o = await owner();
    const res = await call("PATCH", "/api/business", {
      cookie: o.cookie,
      body: { description: "We bake and deliver bread to schools.", monthlyRevenue: 450000, preferredFormat: "Online", skillGaps: ["Digital marketing", "Digital marketing"], interests: ["Digital marketing"] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const b = res.json.business;
    assert.equal(b.description, "We bake and deliver bread to schools.");
    assert.equal(b.monthlyRevenue, 450000);
    assert.ok(!("assetsValue" in b), "the value of assets is no longer asked for");
    assert.equal(b.preferredFormat, "Online");
    assert.deepEqual(b.skillGaps, ["Digital marketing"]);
    assert.deepEqual(b.interests, ["Digital marketing"]);
  });

  it("can be emptied again", async () => {
    const o = await owner();
    await call("PATCH", "/api/business", { cookie: o.cookie, body: { monthlyRevenue: 1000, preferredFormat: "Hybrid", skillGaps: ["Digital marketing"] } });
    const res = await call("PATCH", "/api/business", { cookie: o.cookie, body: { monthlyRevenue: "", preferredFormat: "", skillGaps: [] } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.business.monthlyRevenue, null);
    assert.equal(res.json.business.preferredFormat, "");
    assert.deepEqual(res.json.business.skillGaps, []);
  });

  it("refuse values that are not allowed", async () => {
    const o = await owner();
    for (const body of [
      { monthlyRevenue: -5 },
      { monthlyRevenue: "lots" },
      { monthlyRevenue: 99_000_000_000 },
      { preferredFormat: "By post" },
      { skillGaps: ["Juggling"] },
      { interests: ["Juggling"] },
      { description: "x".repeat(501) },
    ]) {
      const res = await call("PATCH", "/api/business", { cookie: o.cookie, body });
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  it("are not counted in the profile progress", async () => {
    const o = await owner();
    const before = (await call("GET", "/api/business", { cookie: o.cookie })).json.insights;
    const after = (await call("PATCH", "/api/business", { cookie: o.cookie, body: { description: "A description", monthlyRevenue: 5000 } })).json.insights;
    assert.deepEqual(after, before);
  });

  it("are offered in the lists the app reads", async () => {
    const res = await call("GET", "/api/reference");
    assert.equal(res.status, 200);
    assert.ok(res.json.trainingFormats.includes("Hybrid"));
    assert.ok(res.json.skillAreas.length > 0);
    assert.ok(res.json.interestAreas.length >= res.json.skillAreas.length);
  });
});

describe("the logo", () => {
  it("is stored encrypted, shown to the owner and to staff, and never described in the profile", async () => {
    const o = await owner();
    const bytes = png();
    const put = await putLogo(o, bytes);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(Object.keys(put.json.business.logo).sort(), ["mime", "size"]);
    assert.equal(filesOnDisk(), 1);
    // The bytes on disk are not the picture.
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(dir);
    assert.ok(!fs.readFileSync(files[0]).includes(bytes.subarray(10, 40)));

    const mine = await fetchPath("/api/business/logo", o.cookie);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await mine.arrayBuffer()), bytes);

    const staff = await fetchPath(`/api/admin/businesses/${o.businessId}/logo`, admin);
    assert.equal(staff.status, 200);

    const other = await owner();
    const nope = await fetchPath(`/api/admin/businesses/${o.businessId}/logo`, other.cookie);
    assert.ok([401, 403].includes(nope.status));
    const none = await fetchPath("/api/business/logo", other.cookie);
    assert.equal(none.status, 404);
  });

  it("replaces the old file when a new one is uploaded, and is removed on request", async () => {
    const o = await owner();
    await putLogo(o, png());
    const withFirst = filesOnDisk();
    const second = await putLogo(o, jpeg(), "image/jpeg");
    assert.equal(second.status, 200);
    assert.equal(second.json.business.logo.mime, "image/jpeg");
    assert.equal(filesOnDisk(), withFirst, "the old file is gone");
    const del = await fetch(`${ctx.base}/api/business/logo`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: o.cookie } });
    assert.equal(del.status, 204);
    assert.equal((await fetchPath("/api/business/logo", o.cookie)).status, 404);
    assert.equal((await call("GET", "/api/business", { cookie: o.cookie })).json.business.logo, null);
  });

  it("must be a JPEG or PNG and not empty", async () => {
    const o = await owner();
    const before = filesOnDisk();
    assert.equal((await putLogo(o, Buffer.from("%PDF-1.4 not a picture"), "application/pdf")).status, 422);
    assert.equal((await putLogo(o, null)).status, 422);
    assert.equal(filesOnDisk(), before);
  });

  it("needs a signed in owner", async () => {
    assert.equal((await putLogo(null, png())).status, 401);
    assert.equal((await fetchPath("/api/business/logo")).status, 401);
  });
});

describe("ownership flags and the map position", () => {
  it("are saved, can be emptied, and are checked", async () => {
    const o = await owner();
    const res = await call("PATCH", "/api/business", { cookie: o.cookie, body: { womenOwned: "Yes", youthOwned: "No", disabilityOwned: "", exports: "Yes", latitude: "6.5244", longitude: 3.3792 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const b = res.json.business;
    assert.deepEqual([b.womenOwned, b.youthOwned, b.disabilityOwned, b.exports, b.latitude, b.longitude], ["Yes", "No", "", "Yes", 6.5244, 3.3792]);
    const cleared = await call("PATCH", "/api/business", { cookie: o.cookie, body: { latitude: "", longitude: "", womenOwned: "" } });
    assert.equal(cleared.json.business.latitude, null);
    assert.equal(cleared.json.business.womenOwned, "");
    for (const body of [{ womenOwned: "Maybe" }, { latitude: 51.5 }, { longitude: -0.12 }, { latitude: "north" }]) {
      assert.equal((await call("PATCH", "/api/business", { cookie: o.cookie, body })).status, 422, JSON.stringify(body));
    }
  });

  it("work as eligibility rules and show up in how to become eligible", async () => {
    const o = await owner();
    const make = async (key) => {
      const c = await call("POST", "/api/admin/opportunities", {
        cookie: admin,
        body: { title: `For ${key}`, provider: "NMREP", type: "Grant", description: "A programme.", criteria: [{ key, level: "required" }] },
      });
      assert.equal(c.status, 201, c.text);
      await call("PATCH", `/api/admin/opportunities/${c.json.opportunity.id}`, { cookie: admin, body: { status: "Open" } });
      return c.json.opportunity.id;
    };
    const id = await make("womenOwned");
    let detail = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json;
    assert.equal(detail.fit.checks[0].met, false);
    assert.equal(detail.howToQualify.steps[0].key, "womenOwned");
    await call("PATCH", "/api/business", { cookie: o.cookie, body: { womenOwned: "Yes" } });
    detail = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie })).json;
    assert.equal(detail.fit.checks[0].met, true);
    assert.equal(detail.howToQualify.ready, true);
  });
});
