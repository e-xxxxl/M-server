import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { paymentReceiptEmail } from "../src/lib/email-templates.js";
import { Payment } from "../src/models/Payment.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The super admin's list of registration fee payments, and the receipt email naming only the gateway that was used.

let ctx;
let call;
let superCookie;
let adminCookie;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const s = await createStaff({ role: "super_admin" });
  superCookie = (await logIn(call, s.email, s.password)).cookie;
  const a = await createStaff({ role: "admin" });
  adminCookie = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

async function owner(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, res.text);
  return { id: res.json.user.id, businessId: res.json.business.id };
}
let n = 0;
const pay = (o, extra = {}) => Payment.create({ user: o.id, reference: `NMREP-TEST-${Date.now()}-${(n += 1)}`, amountKobo: 100_000, status: "success", paidAt: new Date(), provider: "alatpay", ...extra });

describe("registration fee payments (super admin)", () => {
  it("lists who paid, with the business to open, and the totals", async () => {
    const a = await owner({ businessName: "Paid Traders" });
    const b = await owner({ businessName: "Waiting Traders" });
    await pay(a);
    await pay(b, { status: "pending", paidAt: null, provider: "paystack" });

    const paid = await call("GET", "/api/admin/payments", { cookie: superCookie });
    assert.equal(paid.status, 200, paid.text);
    const row = paid.json.items.find((i) => i.businessId === a.businessId);
    assert.equal(row.businessName, "Paid Traders");
    assert.equal(row.amount, 1000);
    assert.equal(row.provider, "alatpay");
    assert.equal(row.status, "success");
    assert.ok(row.ownerName && row.ownerEmail);
    assert.ok(!paid.json.items.some((i) => i.businessId === b.businessId), "paid is the default view");
    assert.ok(paid.json.totals.paid >= 1 && paid.json.totals.collectedNaira >= 1000 && paid.json.totals.pending >= 1);

    const waiting = await call("GET", "/api/admin/payments?status=pending", { cookie: superCookie });
    assert.ok(waiting.json.items.some((i) => i.businessId === b.businessId));
    const all = await call("GET", "/api/admin/payments?status=all&provider=paystack", { cookie: superCookie });
    assert.ok(all.json.items.every((i) => i.provider === "paystack"));
  });

  it("never exposes transfer details or a user id, and refuses bad filters", async () => {
    const o = await owner();
    await pay(o, { transfer: { bankCode: "035", accountNumber: "0123456789" }, providerRef: "tx-secret-1" });
    const res = await call("GET", "/api/admin/payments", { cookie: superCookie });
    assert.ok(!res.text.includes("0123456789") && !res.text.includes("tx-secret-1"));
    assert.equal((await call("GET", "/api/admin/payments?status=weird", { cookie: superCookie })).status, 422);
  });

  it("is for the super admin only", async () => {
    assert.equal((await call("GET", "/api/admin/payments")).status, 401);
    assert.equal((await call("GET", "/api/admin/payments", { cookie: adminCookie })).status, 403);
  });
});

describe("the receipt email", () => {
  const user = { fullName: "Ada Obi" };
  const make = (provider) => paymentReceiptEmail(user, { amount: 1000, reference: "R1", paidUntil: new Date("2027-01-01"), url: "https://nmrep.test", provider });
  const text = (m) => JSON.stringify(m);

  it("names only the gateway that took the payment", () => {
    assert.ok(!/paystack/i.test(text(make("alatpay"))), "an ALATPay receipt never mentions Paystack");
    assert.match(text(make("alatpay")), /bank transfer/);
    assert.ok(!/alatpay|alat pay/i.test(text(make("paystack"))));
    assert.match(text(make("paystack")), /Paystack/);
    const neither = text(make(undefined));
    assert.ok(!/paystack|alatpay/i.test(neither));
  });
});
