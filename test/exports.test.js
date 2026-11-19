import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cacReason, reviewerView } from "../src/lib/verification.js";
import { Payment } from "../src/models/Payment.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Admin exports: businesses by state, area, sector, type, status and registration days; payments by time range.

let ctx;
let call;
let superCookie;
let adminCookie;
const made = {};

before(async () => {
  ctx = await startTestServer({ RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  superCookie = (await logIn(call, ...Object.values(await credentials("super_admin")))).cookie;
  adminCookie = (await logIn(call, ...Object.values(await credentials("admin")))).cookie;
  made.lagosTextile = await owner({ businessName: "Lagos Textile Co", state: "Lagos", lga: "Ikeja", sector: "Fashion and textiles" });
  made.lagosFood = await owner({ businessName: "Lagos Food Co", state: "Lagos", lga: "Eti-Osa", sector: "Food and hospitality" });
  made.kanoFarm = await owner({ businessName: "Kano Farm Co", state: "Kano", lga: "Nasarawa", sector: "Agriculture and agro-processing", businessType: "Business name (sole owner or partnership)" });
});
after(async () => {
  await ctx.stop();
});

async function credentials(role) {
  const s = await createStaff({ role });
  return { email: s.email, password: s.password };
}
async function owner(business) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, res.text);
  return { id: res.json.user.id, businessId: res.json.business.id, name: business.businessName };
}
const exportBusinesses = (query = "") => call("GET", `/api/admin/export/businesses${query}`, { cookie: adminCookie });
const names = (res) => ["Lagos Textile Co", "Lagos Food Co", "Kano Farm Co"].filter((n) => res.text.includes(n));
let n = 0;
const pay = (o, extra = {}) => Payment.create({ user: o.id, reference: `EXP-${Date.now()}-${(n += 1)}`, amountKobo: 100_000, status: "success", provider: "alatpay", ...extra });

describe("the business export", () => {
  it("with no filter holds everyone, and says what was filtered in the activity log", async () => {
    const res = await exportBusinesses();
    assert.equal(res.status, 200);
    assert.deepEqual(names(res), ["Lagos Textile Co", "Lagos Food Co", "Kano Farm Co"]);
    assert.match(res.text.split("\r\n")[0], /Fee paid until/);
  });

  it("filters by state, by area, by sector (the business category) and by business type", async () => {
    assert.deepEqual(names(await exportBusinesses("?state=Lagos")), ["Lagos Textile Co", "Lagos Food Co"]);
    assert.deepEqual(names(await exportBusinesses("?state=Lagos&lga=Ikeja")), ["Lagos Textile Co"]);
    assert.deepEqual(names(await exportBusinesses("?sector=Agriculture%20and%20agro-processing")), ["Kano Farm Co"]);
    assert.deepEqual(names(await exportBusinesses("?businessType=Business%20name%20(sole%20owner%20or%20partnership)")), ["Kano Farm Co"]);
    assert.deepEqual(names(await exportBusinesses("?state=Kano&sector=Manufacturing")), []);
  });

  it("filters by the days people registered, in Nigerian time, and by whether they paid", async () => {
    assert.deepEqual(names(await exportBusinesses("?from=2000-01-01&to=2000-12-31")), []);
    assert.equal(names(await exportBusinesses("?from=2000-01-01")).length, 3);
    await User.updateOne({ _id: made.kanoFarm.id }, { registrationPaidUntil: new Date(Date.now() + 86_400_000) });
    assert.deepEqual(names(await exportBusinesses("?fee=paid")), ["Kano Farm Co"]);
    assert.deepEqual(names(await exportBusinesses("?fee=unpaid")), ["Lagos Textile Co", "Lagos Food Co"]);
  });

  it("refuses an unknown state, a bad date, or a backwards range", async () => {
    for (const q of ["?state=Narnia", "?from=yesterday", "?from=2026-02-31", "?from=2026-05-02&to=2026-05-01", "?color=red"]) {
      assert.equal((await exportBusinesses(q)).status, 422, q);
    }
  });
});

describe("the payments export and time range", () => {
  before(async () => {
    await pay(made.lagosTextile, { paidAt: new Date("2026-03-10T10:00:00+01:00") });
    await pay(made.lagosFood, { paidAt: new Date("2026-03-20T23:30:00+01:00"), amountKobo: 300_000, years: 3 });
    await pay(made.kanoFarm, { paidAt: new Date("2026-05-01T09:00:00+01:00") });
    await pay(made.kanoFarm, { status: "pending", paidAt: null, reference: `EXP-PEND-${Date.now()}` });
  });
  const list = async (q) => (await call("GET", `/api/admin/payments${q}`, { cookie: superCookie })).json;

  it("the list and its totals follow the range, to the last minute of the last Nigerian day", async () => {
    const march = await list("?from=2026-03-01&to=2026-03-20");
    assert.equal(march.items.length, 2, "the payment at 23:30 on the 20th is inside");
    assert.equal(march.totals.paid, 2);
    assert.equal(march.totals.collectedNaira, 4000);
    const may = await list("?from=2026-04-01&to=2026-06-30");
    assert.equal(may.items.length, 1);
    assert.equal(may.totals.collectedNaira, 1000);
    const none = await list("?from=2025-01-01&to=2025-12-31");
    assert.equal(none.items.length, 0);
    assert.equal(none.totals.paid, 0);
  });

  it("an unpaid attempt counts on the day it was started", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const waiting = await list(`?status=pending&from=${today}&to=${today}`);
    assert.equal(waiting.items.length, 1);
  });

  it("downloads the whole range as a spreadsheet with the business and owner, and is for the super admin only", async () => {
    const res = await call("GET", "/api/admin/payments/export.csv?from=2026-03-01&to=2026-03-31", { cookie: superCookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.ok(res.text.includes("Lagos Textile Co") && res.text.includes("Lagos Food Co") && !res.text.includes("Kano Farm Co"));
    assert.match(res.text.split("\r\n")[0], /"Amount","Currency"/);
    assert.equal((await call("GET", "/api/admin/payments/export.csv", { cookie: adminCookie })).status, 403);
    assert.equal((await call("GET", "/api/admin/payments/export.csv?from=2026-13-01", { cookie: superCookie })).status, 422);
  });
});

describe("the CAC result says the real reason", () => {
  const check = (over) => ({ type: "cac", status: "Needs review", nameMatch: true, companyStatus: "INACTIVE", registeredName: "HOMYDAZE ACADEMY", maskedValue: "***4035", checkedAt: new Date(), ...over });

  it("a matching name with an INACTIVE company says it is the status, not the name", () => {
    const view = reviewerView(check());
    assert.match(view.reason, /name matches, but the register shows the company as "INACTIVE"/);
    assert.match(view.message, /name matches, but the CAC register shows the business as INACTIVE/);
    assert.ok(!/name does not/i.test(view.message));
  });

  it("a name that does not match, with an active company, says it is the name", () => {
    const view = reviewerView(check({ nameMatch: false, companyStatus: "ACTIVE" }));
    assert.match(view.reason, /active, but the registered name does not match/);
    assert.match(view.message, /registered name does not clearly match/);
  });

  it("both problems are both named, and a passed check has no reason", () => {
    assert.match(reviewerView(check({ nameMatch: false })).reason, /does not match the business, and the register shows/);
    assert.equal(cacReason(check({ status: "Passed", companyStatus: "ACTIVE" })), "");
  });
});
