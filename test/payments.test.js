import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { setMailer } from "../src/lib/mailer.js";
import { setPaystack } from "../src/lib/paystack.js";
import { signBody } from "../src/routes/payments.js";
import { Payment } from "../src/models/Payment.js";
import { User } from "../src/models/User.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

const SECRET = "sk_test_not_a_real_key_for_tests";
const DAY = 24 * 60 * 60 * 1000;

let ctx;
let call;
let admin;

// A stand-in for Paystack: it records what it was asked, and answers verify from a table the tests fill in.
const initCalls = [];
const outcomes = new Map();
let initAnswer;
const fakePaystack = {
  enabled: true,
  async initialize(args) {
    initCalls.push(args);
    return initAnswer ? initAnswer(args) : { authorizationUrl: `https://checkout.paystack.test/${args.reference}`, reference: args.reference };
  },
  async verify(reference) {
    return outcomes.get(reference) ?? { found: true, status: "abandoned", amountKobo: 100000, currency: "NGN", paidAt: null, reference };
  },
};
const paid = (reference, overrides = {}) => outcomes.set(reference, { found: true, status: "success", amountKobo: 100000, currency: "NGN", paidAt: new Date(), reference, ...overrides });

const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: SECRET, REGISTRATION_FEE_NAIRA: "1000" });
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  setPaystack(undefined);
  await ctx.stop();
});
beforeEach(() => {
  initCalls.length = 0;
  outcomes.clear();
  initAnswer = undefined;
  mails.sent = [];
  setPaystack(fakePaystack);
  setMailer(mails, { notifications: true, appUrl: "https://nmrep.test" });
});

async function owner() {
  const body = registrationBody();
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, email: body.account.email, userId: res.json.user.id, registration: res.json.registration };
}
const get = (o, path) => call("GET", path, { cookie: o.cookie, origin: null });
const initialize = async (o) => (await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie })).json;
const verify = (o, reference) => call("POST", "/api/payments/registration/verify", { cookie: o.cookie, body: { reference } });

describe("the registration fee gate", () => {
  it("is shown in the reference data and in every sign-up and sign-in answer, and holds an unpaid owner back", async () => {
    const reference = await (await fetch(`${ctx.base}/api/reference`)).json();
    assert.deepEqual(reference.registrationFee, { required: true, amount: 1000, currency: "NGN" });

    const o = await owner();
    assert.deepEqual(o.registration, { required: true, paid: false, paidUntil: null, amount: 1000, currency: "NGN", canRenew: false });

    for (const path of ["/api/dashboard", "/api/business", "/api/opportunities", "/api/applications", "/api/documents", "/api/verification", "/api/health-profile", "/api/training", "/api/consents"]) {
      const res = await get(o, path);
      assert.equal(res.status, 402, path);
      assert.equal(res.json.error.code, "payment_required");
    }
    // What an unpaid owner can still do: read notifications, manage the account, see the fee, sign out, delete the account.
    for (const path of ["/api/notifications", "/api/auth/me", "/api/payments/registration", "/api/account/notification-settings"]) {
      assert.equal((await get(o, path)).status, 200, path);
    }
    const login = await call("POST", "/api/auth/login", { body: { identifier: o.email, password: "Secret123" } });
    assert.equal(login.json.registration.paid, false);
  });

  it("never holds staff back", async () => {
    assert.equal((await call("GET", "/api/admin/overview", { cookie: admin, origin: null })).status, 200);
  });
});

describe("paying the fee", () => {
  it("starts a payment for exactly 1,000 naira, then accepts it once Paystack says it was paid", async () => {
    const o = await owner();
    const started = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie });
    assert.equal(started.status, 201, JSON.stringify(started.json));
    assert.match(started.json.reference, /^NMREG-[A-F0-9]{16}$/);
    assert.equal(started.json.authorizationUrl, `https://checkout.paystack.test/${started.json.reference}`);
    assert.equal(started.json.amount, 1000);
    assert.deepEqual(initCalls[0], { email: o.email, amountKobo: 100000, reference: started.json.reference, callbackUrl: "https://nmrep.test/pay/", metadata: { purpose: "registration" } });

    // Not paid yet: Paystack says the payer abandoned the page.
    const waiting = await verify(o, started.json.reference);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.json.outcome, "failed");
    assert.equal(waiting.json.registration.paid, false);

    // A new attempt, paid this time.
    const second = await initialize(o);
    paid(second.reference);
    const done = await verify(o, second.reference);
    assert.equal(done.json.outcome, "success");
    assert.equal(done.json.registration.paid, true);
    const until = new Date(done.json.registration.paidUntil).getTime();
    assert.ok(Math.abs(until - (Date.now() + 365 * DAY)) < 60_000, "a year from now");

    // The owner is let in, told, and sent a receipt.
    assert.equal((await get(o, "/api/dashboard")).status, 200);
    const note = (await get(o, "/api/notifications")).json.items.find((n) => n.type === "payment");
    assert.ok(note);
    const receipt = mails.sent.find((m) => /receipt/i.test(m.subject));
    assert.ok(receipt);
    assert.match(receipt.text, /1,000/);
    assert.ok(receipt.text.includes(second.reference));
    assert.ok(!/card number|cvv/i.test(receipt.text + receipt.html));

    // Checking again changes nothing: the same payment is never counted twice.
    const again = await verify(o, second.reference);
    assert.equal(again.json.outcome, "success");
    assert.equal(new Date(again.json.registration.paidUntil).getTime(), until);
    assert.equal(mails.sent.filter((m) => /receipt/i.test(m.subject)).length, 1);
  });

  it("does not accept the wrong amount or currency, someone else's payment, or an unknown reference", async () => {
    const o = await owner();
    const p = await initialize(o);
    paid(p.reference, { amountKobo: 50000 });
    assert.equal((await verify(o, p.reference)).json.outcome, "failed");
    assert.equal((await get(o, "/api/dashboard")).status, 402);

    const q = await initialize(o);
    paid(q.reference);
    const other = await owner();
    assert.equal((await verify(other, q.reference)).status, 404, "another owner cannot use this reference");
    assert.equal((await verify(o, "NMREG-0000000000000000")).status, 404);
    assert.equal((await call("POST", "/api/payments/registration/verify", { cookie: o.cookie, body: {} })).status, 422);
  });

  it("says so when Paystack cannot be reached", async () => {
    const o = await owner();
    initAnswer = () => ({ unavailable: true });
    const res = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "payments_unavailable");
    assert.equal(await Payment.countDocuments({ user: o.userId, status: "pending" }), 0, "the attempt is closed, not left pending");
  });

  it("a paid year can be renewed only in the last 30 days, and adds a year to the end of the current one", async () => {
    const o = await owner();
    const p = await initialize(o);
    paid(p.reference);
    await verify(o, p.reference);

    const tooEarly = await call("POST", "/api/payments/registration/initialize", { cookie: o.cookie });
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.json.error.code, "already_paid");

    const endsIn10 = new Date(Date.now() + 10 * DAY);
    await User.updateOne({ _id: o.userId }, { $set: { registrationPaidUntil: endsIn10 } });
    assert.equal((await get(o, "/api/payments/registration")).json.registration.canRenew, true);
    const renewal = await initialize(o);
    paid(renewal.reference);
    const done = await verify(o, renewal.reference);
    assert.equal(new Date(done.json.registration.paidUntil).getTime(), endsIn10.getTime() + 365 * DAY);
  });

  it("an expired year holds the owner back again", async () => {
    const o = await owner();
    const p = await initialize(o);
    paid(p.reference);
    await verify(o, p.reference);
    assert.equal((await get(o, "/api/dashboard")).status, 200);
    await User.updateOne({ _id: o.userId }, { $set: { registrationPaidUntil: new Date(Date.now() - DAY) } });
    assert.equal((await get(o, "/api/dashboard")).status, 402);
    assert.equal((await get(o, "/api/payments/registration")).json.registration.paid, false);
  });
});

describe("the Paystack webhook", () => {
  const send = (body, signature) =>
    fetch(`${ctx.base}/api/webhooks/paystack`, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "x-paystack-signature": signature } : {}) }, body });

  it("refuses a message that is not signed with the secret key", async () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "NMREG-AAAAAAAAAAAAAAAA" } });
    assert.equal((await send(body)).status, 401);
    assert.equal((await send(body, "0".repeat(128))).status, 401);
    assert.equal((await send(body, signBody(body, "sk_test_another_key"))).status, 401);
  });

  it("settles a payment when the payer never came back to the site, and ignores everything else", async () => {
    const o = await owner();
    const p = await initialize(o);
    paid(p.reference);
    const body = JSON.stringify({ event: "charge.success", data: { reference: p.reference, status: "success" } });
    const ok = await send(body, signBody(body, SECRET));
    assert.equal(ok.status, 200);
    assert.equal((await get(o, "/api/dashboard")).status, 200, "paid without the owner returning to the site");

    // The same message again, and other events and references, change nothing.
    assert.equal((await send(body, signBody(body, SECRET))).status, 200);
    assert.equal(mails.sent.filter((m) => /receipt/i.test(m.subject)).length, 1);
    const other = JSON.stringify({ event: "transfer.success", data: { reference: p.reference } });
    assert.equal((await send(other, signBody(other, SECRET))).status, 200);
    const unknown = JSON.stringify({ event: "charge.success", data: { reference: "SOMETHING-ELSE" } });
    assert.equal((await send(unknown, signBody(unknown, SECRET))).status, 200);
    assert.equal(await Payment.countDocuments({ status: "success" }) >= 1, true);
  });

  it("does not trust the message alone: Paystack is asked, and a payment it does not confirm stays unpaid", async () => {
    const o = await owner();
    const p = await initialize(o); // verify answers "abandoned" by default
    const body = JSON.stringify({ event: "charge.success", data: { reference: p.reference } });
    assert.equal((await send(body, signBody(body, SECRET))).status, 200);
    assert.equal((await get(o, "/api/dashboard")).status, 402);
  });
});

describe("when no Paystack key is set", () => {
  it("nobody is asked to pay", async () => {
    const { startExtraApp } = await import("./helpers.js");
    const app = await startExtraApp({ PAYSTACK_SECRET_KEY: "" });
    try {
      const body = registrationBody();
      const reg = await fetch(`${app.base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body) });
      const json = await reg.json();
      assert.equal(reg.status, 201);
      assert.equal(json.registration.required, false);
      assert.equal(json.registration.paid, true);
      const cookie = reg.headers.getSetCookie().find((c) => c.startsWith("nmrep_session=")).split(";")[0];
      const dash = await fetch(`${app.base}/api/dashboard`, { headers: { Cookie: cookie } });
      assert.equal(dash.status, 200);
      const init = await fetch(`${app.base}/api/payments/registration/initialize`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
      assert.equal(init.status, 503, "there is nothing to pay without a key");
    } finally {
      await app.stop();
    }
  });
});
