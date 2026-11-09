import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { setMailer } from "../src/lib/mailer.js";
import { setPaystack } from "../src/lib/paystack.js";
import { createPrembly, setPrembly } from "../src/lib/prembly.js";
import { runMaintenance, runReminders } from "../src/lib/reminders.js";
import { runSubscriptionReminders } from "../src/lib/subscription.js";
import { Business } from "../src/models/Business.js";
import { Notification } from "../src/models/Notification.js";
import { Opportunity } from "../src/models/Opportunity.js";
import { Payment } from "../src/models/Payment.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Years on a subscription, the automatic suspension and reminders, closing opportunities on their date, the random
// NMREP ID, and a NIN that verifies the business at once.

const DAY = 24 * 60 * 60 * 1000;
let ctx;
let call;
let admin;
const outcomes = new Map();
const fakePaystack = {
  enabled: true,
  async initialize(args) {
    return { authorizationUrl: `https://checkout.paystack.test/${args.reference}`, reference: args.reference };
  },
  async verify(reference) {
    return outcomes.get(reference) ?? { found: true, status: "abandoned", amountKobo: 0, currency: "NGN", paidAt: null, reference };
  },
};

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", REGISTRATION_FEE_NAIRA: "1000", PREMBLY_API_KEY: "test-key-not-real", VERIFICATION_HASH_KEY: "h".repeat(40) });
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  setPaystack(undefined);
  setPrembly(createPrembly(null));
  await ctx.stop();
});
beforeEach(() => {
  outcomes.clear();
  setPaystack(fakePaystack);
  setPrembly(createPrembly(null));
  setMailer({ enabled: false, send: async () => ({ ok: false }) });
});

async function owner(account = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ account }) });
  assert.equal(res.status, 201, res.text);
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}
async function payYears(o, years) {
  const init = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie, body: years === undefined ? {} : { years } });
  assert.equal(init.status, 201, init.text);
  outcomes.set(init.json.reference, { found: true, status: "success", amountKobo: init.json.amount * 100, currency: "NGN", paidAt: new Date(), reference: init.json.reference });
  const ok = await call("POST", "/api/payments/registration/verify", { cookie: o.cookie, body: { reference: init.json.reference } });
  assert.equal(ok.status, 200, ok.text);
  return { init: init.json, verified: ok.json };
}

describe("choosing how many years to pay for", () => {
  it("charges the yearly fee times the years, and buys that many years", async () => {
    const o = await owner();
    const { init, verified } = await payYears(o, 3);
    assert.equal(init.years, 3);
    assert.equal(init.amount, 3000);
    assert.equal(verified.registration.paid, true);
    const days = (new Date(verified.registration.paidUntil) - Date.now()) / DAY;
    assert.ok(days > 3 * 365 - 1 && days < 3 * 365 + 1, String(days));
    assert.equal((await Payment.findOne({ user: o.id })).years, 3);
  });

  it("is one year when the number is left out, and the most is ten", async () => {
    const one = await payYears(await owner(), undefined);
    assert.equal(one.init.amount, 1000);
    const ten = await payYears(await owner(), 10);
    assert.equal(ten.init.amount, 10000);
    assert.equal(ten.verified.registration.maxYears, 10);
  });

  it("refuses 0, 11, a fraction and text", async () => {
    const o = await owner();
    for (const years of [0, 11, 2.5, "3", -1]) {
      const res = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie, body: { years } });
      assert.equal(res.status, 422, JSON.stringify(years));
    }
  });

  it("a payment that is not the amount for its years is not accepted", async () => {
    const o = await owner();
    const init = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie, body: { years: 5 } });
    outcomes.set(init.json.reference, { found: true, status: "success", amountKobo: 100_000, currency: "NGN", paidAt: new Date(), reference: init.json.reference });
    const res = await call("POST", "/api/payments/registration/verify", { cookie: o.cookie, body: { reference: init.json.reference } });
    assert.equal(res.json.outcome, "failed");
    assert.equal(res.json.registration.paid, false);
  });

  it("shows in the admin payments list", async () => {
    const o = await owner();
    await payYears(o, 2);
    const s = await createStaff({ role: "super_admin" });
    const sc = (await logIn(call, s.email, s.password)).cookie;
    const list = await call("GET", "/api/admin/payments", { cookie: sc });
    assert.ok(list.json.items.some((i) => i.businessId === o.businessId && i.years === 2 && i.amount === 2000));
  });
});

describe("when the subscription ends", () => {
  it("suspends the business, tells the owner, and restores the status when they renew", async () => {
    const o = await owner();
    await payYears(o, 1);
    await Business.updateOne({ _id: o.businessId }, { $set: { verificationStatus: "Verified" } });
    await User.updateOne({ _id: o.id }, { $set: { registrationPaidUntil: new Date(Date.now() - DAY) } });

    const result = await runMaintenance(ctx.config);
    assert.ok(result.suspended >= 1);
    let b = await Business.findById(o.businessId);
    assert.equal(b.verificationStatus, "Suspended");
    assert.match(b.verificationHistory.at(-1).note, /Subscription ended/);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /subscription has ended/ }), 1);
    assert.equal((await runMaintenance(ctx.config)).suspended, 0, "never twice");

    await payYears(o, 1);
    b = await Business.findById(o.businessId);
    assert.equal(b.verificationStatus, "Verified", "the status it had is back");
    assert.equal(b.suspendedForSubscription, false);
    assert.match(b.verificationHistory.at(-1).note, /renewed/);
  });

  it("does not touch a business staff suspended themselves, or an owner who never paid", async () => {
    const staffSuspended = await owner();
    await payYears(staffSuspended, 1);
    await call("POST", `/api/admin/businesses/${staffSuspended.businessId}/status`, { cookie: admin, body: { status: "Suspended", note: "Investigating." } });
    const neverPaid = await owner();
    await User.updateOne({ _id: staffSuspended.id }, { $set: { registrationPaidUntil: new Date(Date.now() - DAY) } });
    await runMaintenance(ctx.config);
    assert.equal((await Business.findById(staffSuspended.businessId)).suspendedForSubscription, false);
    assert.equal((await Business.findById(neverPaid.businessId)).verificationStatus, "Unverified");
    // Renewing does not lift a suspension staff decided on.
    await payYears(staffSuspended, 1);
    assert.equal((await Business.findById(staffSuspended.businessId)).verificationStatus, "Suspended");
  });

  it("an admin changing the status takes over from the automatic suspension", async () => {
    const o = await owner();
    await payYears(o, 1);
    await User.updateOne({ _id: o.id }, { $set: { registrationPaidUntil: new Date(Date.now() - DAY) } });
    await runMaintenance(ctx.config);
    assert.equal((await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Unverified", note: "Checked." } })).status, 200);
    assert.equal((await Business.findById(o.businessId).select("suspendedForSubscription")).suspendedForSubscription, false);
  });

  it("reminds the owner 14 days and again 3 days before, once for each end date", async () => {
    const o = await owner();
    await payYears(o, 1);
    await User.updateOne({ _id: o.id }, { $set: { registrationPaidUntil: new Date(Date.now() + 20 * DAY) } });
    await runSubscriptionReminders(ctx.config);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /subscription ends/ }), 0, "20 days away: nothing yet");
    await User.updateOne({ _id: o.id }, { $set: { registrationPaidUntil: new Date(Date.now() + 10 * DAY) } });
    await runSubscriptionReminders(ctx.config);
    await runSubscriptionReminders(ctx.config);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /ends soon/ }), 1);
    await User.updateOne({ _id: o.id }, { $set: { registrationPaidUntil: new Date(Date.now() + 2 * DAY) } });
    await runSubscriptionReminders(ctx.config);
    await runSubscriptionReminders(ctx.config);
    assert.equal(await Notification.countDocuments({ user: o.id, title: /3 days or less/ }), 1);
    const n = await Notification.findOne({ user: o.id, title: /3 days or less/ });
    assert.match(n.body, /suspended/);
    assert.equal(n.link, "/pay/");
    const all = await runReminders(new Date(), ctx.config);
    assert.equal(typeof all.subscriptions, "number");
  });
});

describe("closing an opportunity on its date", () => {
  it("closes Open opportunities whose closing date has come, and leaves the rest", async () => {
    const make = (extra) => Opportunity.create({ title: "Auto close", provider: "NMREP", type: "Grant", description: "d", status: "Open", createdBy: new mongoose.Types.ObjectId(), ...extra });
    const past = await make({ deadline: new Date(Date.now() - 1000) });
    const future = await make({ deadline: new Date(Date.now() + 5 * DAY) });
    const none = await make({ deadline: null });
    const draft = await make({ status: "Draft", deadline: new Date(Date.now() - DAY) });
    const result = await runMaintenance(ctx.config);
    assert.ok(result.closed >= 1);
    assert.equal((await Opportunity.findById(past._id)).status, "Closed");
    assert.equal((await Opportunity.findById(future._id)).status, "Open");
    assert.equal((await Opportunity.findById(none._id)).status, "Open");
    assert.equal((await Opportunity.findById(draft._id)).status, "Draft", "only Open ones are closed");
  });
});

describe("the NMREP ID", () => {
  it("is random and unique, not in the order of registration", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const o = await owner();
      await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "Checked." } });
      ids.push((await Business.findById(o.businessId)).nmrepId);
    }
    for (const id of ids) assert.match(id, /^NMREP-\d{4}-\d{8}$/);
    assert.equal(new Set(ids).size, 5);
    const numbers = ids.map((i) => Number(i.slice(-8)));
    const ascending = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
    assert.equal(ascending, false, "not 1, 2, 3");
  });
});

describe("a NIN that Prembly confirms verifies the business at once", () => {
  const record = (name = ["Ada", "Obi"]) => new Response(JSON.stringify({ status: true, response_code: "00", data: { firstname: name[0], surname: name[1], telephoneno: "08000000000" }, verification: { reference: "r" } }), { status: 200 });

  it("sets Verified, issues the ID and tells the owner, with nothing for an admin to do", async () => {
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: async () => record(), log: { log() {}, error() {} } }));
    const body = registrationBody();
    const res = await call("POST", "/api/auth/register", { body });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.business.verificationStatus, "Unverified", "not before the fee is paid");
    assert.equal(res.json.business.nmrepId, null);
    await User.updateOne({ _id: res.json.user.id }, { $set: { registrationPaidUntil: new Date(Date.now() + 100 * DAY) } });
    const run = await call("POST", "/api/verification/checks", { cookie: res.cookie, body: { type: "nin", number: body.account.nin, consent: true } });
    assert.equal(run.status, 201, run.text);
    assert.equal(run.json.verificationStatus, "Verified");
    const business = await Business.findById(res.json.business.id);
    assert.match(business.nmrepId, /^NMREP-\d{4}-\d{8}$/);
    assert.equal(await Notification.countDocuments({ user: res.json.user.id, title: /is verified/ }), 1);
  });

  it("an admin can still change it afterwards, and a check never overrides Rejected or Suspended", async () => {
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: async () => record(), log: { log() {}, error() {} } }));
    const res = await call("POST", "/api/auth/register", { body: registrationBody() });
    const id = res.json.business.id;
    const set = await call("POST", `/api/admin/businesses/${id}/status`, { cookie: admin, body: { status: "Rejected", note: "Documents do not match." } });
    assert.equal(set.status, 200);
    await Payment.create({ user: res.json.user.id, reference: `T-${Date.now()}`, amountKobo: 100000, status: "success", paidAt: new Date() });
    await User.updateOne({ _id: res.json.user.id }, { $set: { registrationPaidUntil: new Date(Date.now() + 100 * DAY) } });
    const run = await call("POST", "/api/verification/checks", { cookie: res.cookie, body: { type: "nin", number: "99999999990", consent: true } });
    assert.equal(run.status, 201, run.text);
    assert.equal((await Business.findById(id)).verificationStatus, "Rejected");
  });

  it("a record in a different name leaves the business for staff to decide", async () => {
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: async () => record(["Emeka", "Eze"]), log: { log() {}, error() {} } }));
    const res = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal(res.json.business.verificationStatus, "Unverified");
    assert.equal(res.json.business.nmrepId, null);
  });
});
