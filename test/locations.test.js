import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import { seedLgas } from "../src/lib/lgas.js";
import { states } from "../src/options.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Business } from "../src/models/Business.js";
import { Lga } from "../src/models/Lga.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Managed local government areas: the supplied list as the starting point, dropdown data for the website and the app,
// the area having to belong to the state, and the super admin managing the list.

let ctx;
let call;
let sup;
let supCookie;
let adminCookie;
const data = JSON.parse(fs.readFileSync(new URL("../src/data/lgas.json", import.meta.url), "utf8"));

before(async () => {
  ctx = await startTestServer({ RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  await seedLgas();
  sup = await createStaff({ role: "super_admin" });
  supCookie = (await logIn(call, sup.email, sup.password)).cookie;
  adminCookie = (await logIn(call, ...Object.values(await credentials("admin")))).cookie;
});
after(async () => {
  await ctx.stop();
});

async function credentials(role) {
  const s = await createStaff({ role });
  return { email: s.email, password: s.password };
}
const register = (business = {}) => call("POST", "/api/auth/register", { body: registrationBody({ business }) });

describe("the starting list", () => {
  it("has every state and a sensible number of areas, loaded once", async () => {
    assert.deepEqual(Object.keys(data), states, "the states are ours, in our order");
    const total = Object.values(data).reduce((n, l) => n + l.length, 0);
    assert.ok(total >= 760 && total <= 780, `about 774, got ${total}`);
    assert.equal(await Lga.countDocuments(), total);
    assert.equal(await seedLgas(), 0, "a second start adds nothing");
    assert.equal(await Lga.countDocuments(), total);
  });

  it("is clean: no empty names, stray punctuation, double spaces or repeats", () => {
    for (const [state, names] of Object.entries(data)) {
      const keys = new Set();
      for (const n of names) {
        assert.ok(n.length > 1, `${state}: "${n}"`);
        assert.equal(n, n.trim(), `${state}: "${n}" has spaces around it`);
        assert.ok(!/[,.]$/.test(n), `${state}: "${n}" ends with punctuation`);
        assert.ok(!/\s{2,}/.test(n), `${state}: "${n}" has a double space`);
        assert.ok(/^[A-Z]/.test(n), `${state}: "${n}" starts with a lower case letter`);
        const k = n.toLowerCase().replace(/[^a-z0-9]/g, "");
        assert.ok(!keys.has(k), `${state}: "${n}" appears twice`);
        keys.add(k);
      }
    }
  });
});

describe("the public list for dropdowns", () => {
  it("lists the active areas of every state, with a version, and no sign-in", async () => {
    const res = await call("GET", "/api/lgas", {});
    assert.equal(res.status, 200);
    assert.equal(Object.keys(res.json.lgas).length, 37);
    assert.ok(res.json.lgas.Lagos.includes("Ikeja"));
    assert.ok(res.json.lgas.Kano.includes("Nasarawa"));
    assert.ok(res.json.version > 0);
    assert.deepEqual(res.json.lgas.Lagos, [...res.json.lgas.Lagos].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("gives one state when asked, and refuses an unknown state or any other query", async () => {
    const one = await call("GET", "/api/lgas?state=Lagos", {});
    assert.deepEqual(Object.keys(one.json.lgas), ["Lagos"]);
    assert.equal(one.json.lgas.Lagos.length, data.Lagos.length);
    assert.equal((await call("GET", "/api/lgas?state=Atlantis", {})).status, 422);
    assert.equal((await call("GET", "/api/lgas?page=2", {})).status, 422);
  });
});

describe("the area has to belong to the state", () => {
  it("accepts an area of the state, in any spelling of capitals and hyphens, and stores its proper form", async () => {
    const ok = await register({ state: "Lagos", lga: "ibeju lekki" });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.business.lga, "Ibeju-Lekki");
    const stored = await Business.findById(ok.json.business.id);
    assert.equal(stored.lga, "Ibeju-Lekki");
  });

  it("refuses an area of another state, and an invented one, with a message on the field", async () => {
    for (const lga of ["Nasarawa", "Atlantis", "", "Ikeja Central"]) {
      const res = await register({ state: "Lagos", lga });
      assert.equal(res.status, 422, lga);
      assert.ok(res.json.error.fields["business.lga"], lga);
    }
    assert.match((await register({ state: "Lagos", lga: "Kano" })).json.error.fields["business.lga"], /Lagos/);
  });

  it("is checked when the profile changes: a new state needs one of its own areas", async () => {
    const reg = await register({ state: "Lagos", lga: "Ikeja" });
    const cookie = reg.cookie;
    const move = await call("PATCH", "/api/business", { cookie, body: { state: "Kano" } });
    assert.equal(move.status, 422, "Ikeja is not in Kano");
    assert.ok(move.json.error.fields.lga);
    const both = await call("PATCH", "/api/business", { cookie, body: { state: "Kano", lga: "Fagge" } });
    assert.equal(both.status, 200, JSON.stringify(both.json));
    assert.equal(both.json.business.state, "Kano");
    assert.equal(both.json.business.lga, "Fagge");
    assert.equal((await call("PATCH", "/api/business", { cookie, body: { lga: "Ikeja" } })).status, 422);
    assert.equal((await call("PATCH", "/api/business", { cookie, body: { employees: 12 } })).status, 200, "other changes are not held up");
  });

  it("does not stop a profile that already has an older value from changing other things", async () => {
    const reg = await register({ state: "Lagos", lga: "Ikeja" });
    await Business.updateOne({ _id: reg.json.business.id }, { $set: { lga: "Some old free text" } });
    assert.equal((await call("PATCH", "/api/business", { cookie: reg.cookie, body: { industry: "Printing" } })).status, 200);
  });
});

describe("managing the list (super admin)", () => {
  it("shows every state with its areas and how many businesses use each", async () => {
    await register({ state: "Lagos", lga: "Surulere" });
    const res = await call("GET", "/api/admin/locations", { cookie: supCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.states.length, 37);
    const lagos = res.json.states.find((s) => s.state === "Lagos");
    assert.equal(lagos.total, data.Lagos.length);
    assert.equal(lagos.active, data.Lagos.length);
    assert.ok(lagos.lgas.find((l) => l.name === "Surulere").businesses >= 1);
    assert.equal(res.json.total, await Lga.countDocuments());
  });

  it("adds an area, refuses a repeat in any capitals, and the new area works at once", async () => {
    const add = await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Lagos", name: "Test Area Alpha" } });
    assert.equal(add.status, 201, JSON.stringify(add.json));
    assert.equal(add.json.lga.businesses, 0);
    const again = await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Lagos", name: "test area alpha" } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "lga_exists");
    assert.equal((await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Kano", name: "Test Area Alpha" } })).status, 201, "another state may have the same name");
    assert.equal((await register({ state: "Lagos", lga: "Test Area Alpha" })).status, 201);
    assert.ok((await call("GET", "/api/lgas?state=Lagos", {})).json.lgas.Lagos.includes("Test Area Alpha"));
    for (const body of [{ state: "Atlantis", name: "X" }, { state: "Lagos", name: "" }, { state: "Lagos", name: "x".repeat(81) }, { state: "Lagos", name: "Y", extra: 1 }]) {
      assert.equal((await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body })).status, 422, JSON.stringify(body));
    }
  });

  it("renaming moves the businesses that carry the old name, and keeps the rest", async () => {
    const add = await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Ogun", name: "Rename Me" } });
    const id = add.json.lga.id;
    const a = await register({ state: "Ogun", lga: "Rename Me" });
    const other = await register({ state: "Ogun", lga: "Ifo" });
    const renamed = await call("PATCH", `/api/admin/locations/lgas/${id}`, { cookie: supCookie, body: { name: "Renamed Area" } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.equal(renamed.json.businessesUpdated, 1);
    assert.equal(renamed.json.lga.businesses, 1);
    assert.equal((await Business.findById(a.json.business.id)).lga, "Renamed Area");
    assert.equal((await Business.findById(other.json.business.id)).lga, "Ifo");
    const clash = await call("PATCH", `/api/admin/locations/lgas/${id}`, { cookie: supCookie, body: { name: "Ifo" } });
    assert.equal(clash.status, 409);
  });

  it("turning an area off stops it being offered or accepted, but businesses keep it; turning it on restores it", async () => {
    const add = await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Oyo", name: "Switch Me" } });
    const id = add.json.lga.id;
    const user = await register({ state: "Oyo", lga: "Switch Me" });
    const off = await call("PATCH", `/api/admin/locations/lgas/${id}`, { cookie: supCookie, body: { active: false } });
    assert.equal(off.json.lga.active, false);
    assert.ok(!(await call("GET", "/api/lgas?state=Oyo", {})).json.lgas.Oyo.includes("Switch Me"));
    assert.equal((await register({ state: "Oyo", lga: "Switch Me" })).status, 422);
    assert.equal((await Business.findById(user.json.business.id)).lga, "Switch Me", "the business keeps it");
    const on = await call("PATCH", `/api/admin/locations/lgas/${id}`, { cookie: supCookie, body: { active: true } });
    assert.equal(on.json.lga.active, true);
    assert.equal((await register({ state: "Oyo", lga: "Switch Me" })).status, 201);
  });

  it("deleting works only for an area nobody uses", async () => {
    const free = (await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Benue", name: "Unused Area" } })).json.lga.id;
    const busy = (await call("POST", "/api/admin/locations/lgas", { cookie: supCookie, body: { state: "Benue", name: "Used Area" } })).json.lga.id;
    await register({ state: "Benue", lga: "Used Area" });
    const blocked = await call("DELETE", `/api/admin/locations/lgas/${busy}`, { cookie: supCookie });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "lga_in_use");
    assert.equal((await call("DELETE", `/api/admin/locations/lgas/${free}`, { cookie: supCookie })).status, 204);
    assert.equal(await Lga.countDocuments({ _id: free }), 0);
    assert.equal((await call("DELETE", `/api/admin/locations/lgas/${free}`, { cookie: supCookie })).status, 404);
    assert.equal((await call("DELETE", "/api/admin/locations/lgas/not-an-id", { cookie: supCookie })).status, 404);
  });

  it("is for the super admin only, and every change is in the activity log", async () => {
    assert.equal((await call("GET", "/api/admin/locations", { cookie: adminCookie })).status, 403);
    assert.equal((await call("POST", "/api/admin/locations/lgas", { cookie: adminCookie, body: { state: "Lagos", name: "Nope" } })).status, 403);
    assert.equal((await call("GET", "/api/admin/locations", {})).status, 401);
    const owner = await register();
    assert.equal((await call("GET", "/api/admin/locations", { cookie: owner.cookie })).status, 403);
    for (const action of ["location.create", "location.rename", "location.toggle", "location.delete"]) {
      assert.ok(await AuditLog.exists({ action }), action);
    }
  });
});
