import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { alatpay, bankNameFor, createAlatpay, normaliseStatus, setAlatpay } from "../src/lib/alatpay.js";
import { setMailer } from "../src/lib/mailer.js";
import { setPaystack } from "../src/lib/paystack.js";
import { Payment } from "../src/models/Payment.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startExtraApp, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// ALATPay: the client against a stand-in for its API, the bank transfer flow through our API, the webhook, and the super
// admin choosing between ALATPay and Paystack.

const KEY = "alat_secret_not_real_for_tests";
const BUSINESS = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("the ALATPay client", () => {
  const answers = (json, status = 200) => async () => ({ status, ok: status < 400, json: async () => json });

  it("asks for a virtual account with the secret key in the documented header and the amount in naira", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, ok: true, json: async () => ({ status: true, data: { transactionId: "tx-1", virtualBankAccountNumber: "8880007577", virtualBankCode: "035", expiredAt: "2030-01-01T00:00:00.000Z" } }) };
    };
    const c = createAlatpay({ secretKey: KEY, businessId: BUSINESS, baseUrl: "https://alat.test" }, { fetchImpl });
    const r = await c.initialize({ orderId: "NMREGABC", amountNaira: 1000, email: "a@example.com", phone: "08030000000", firstName: "Ada", lastName: "Obi" });
    assert.deepEqual({ ...r, expiresAt: r.expiresAt.toISOString() }, { transactionId: "tx-1", accountNumber: "8880007577", bankCode: "035", expiresAt: "2030-01-01T00:00:00.000Z" });
    assert.equal(seen[0].url, "https://alat.test/bank-transfer/api/v1/bankTransfer/virtualAccount");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.headers["Ocp-Apim-Subscription-Key"], KEY);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.businessId, BUSINESS);
    assert.equal(body.amount, 1000);
    assert.equal(body.currency, "NGN");
    assert.equal(body.orderId, "NMREGABC");
    assert.equal(body.customer.email, "a@example.com");
    assert.ok(!seen[0].init.body.includes(KEY), "the key is only in the header");
  });

  it("checks a transaction at the documented address and trusts only a completed one that is ours", async () => {
    const seen = [];
    const make = (data) => createAlatpay({ secretKey: KEY, businessId: BUSINESS, baseUrl: "https://alat.test" }, { fetchImpl: async (url) => (seen.push(url), { status: 200, ok: true, json: async () => ({ status: true, data }) }) });
    const done = { status: "completed", amount: 1000, currency: "NGN", orderId: "NMREGABC", businessId: BUSINESS, updatedAt: "2030-01-02T00:00:00Z" };
    const ok = await make(done).verify({ transactionId: "tx 1", orderId: "NMREGABC" });
    assert.equal(seen[0], "https://alat.test/alatpaytransaction/api/v1/transactions/tx%201");
    assert.deepEqual({ found: ok.found, status: ok.status, amountKobo: ok.amountKobo, currency: ok.currency }, { found: true, status: "success", amountKobo: 100000, currency: "NGN" });
    assert.equal((await make({ ...done, status: "pending" }).verify({ transactionId: "t", orderId: "NMREGABC" })).status, "pending");
    assert.equal((await make({ ...done, status: "failed" }).verify({ transactionId: "t", orderId: "NMREGABC" })).status, "failed");
    assert.equal((await make({ ...done, status: "something new" }).verify({ transactionId: "t", orderId: "NMREGABC" })).status, "pending", "an unknown word is never read as paid");
    assert.equal((await make({ ...done, businessId: "another-business" }).verify({ transactionId: "t", orderId: "NMREGABC" })).found, false, "another business's transaction");
    assert.equal((await make({ ...done, orderId: "SOMETHINGELSE" }).verify({ transactionId: "t", orderId: "NMREGABC" })).found, false, "another order");
    assert.equal((await make({ ...done, isAmountDiscrepant: true }).verify({ transactionId: "t", orderId: "NMREGABC" })).status, "pending", "a different amount is not accepted");
  });

  it("never throws: no key, a refused key, a server error and a dead network all answer unavailable", async () => {
    const quiet = { error() {} };
    assert.deepEqual(await createAlatpay(null).initialize({}), { unavailable: true });
    assert.equal(createAlatpay({ secretKey: KEY, businessId: "" }).enabled, false, "both the key and the business id are needed");
    for (const fetchImpl of [answers({}, 401), answers({}, 403), answers({}, 500), answers({}, 429), async () => { throw new Error("offline"); }]) {
      const c = createAlatpay({ secretKey: KEY, businessId: BUSINESS, baseUrl: "https://alat.test" }, { fetchImpl, log: quiet });
      assert.deepEqual(await c.verify({ transactionId: "t" }), { unavailable: true });
      assert.deepEqual(await c.initialize({ orderId: "x", amountNaira: 1 }), { unavailable: true });
    }
  });

  it("reads status words and bank codes", () => {
    assert.equal(normaliseStatus("Completed"), "success");
    assert.equal(normaliseStatus("pending"), "pending");
    assert.equal(normaliseStatus("EXPIRED"), "failed");
    assert.equal(normaliseStatus(undefined), "pending");
    assert.equal(bankNameFor("035"), "Wema Bank");
    assert.equal(bankNameFor("999"), "Bank (code 999)");
  });
});

describe("paying the registration fee by bank transfer", () => {
  let ctx;
  let call;
  let superCookie;
  let sup;
  const started = [];
  const outcomes = new Map();
  let n = 0;
  const fake = {
    enabled: true,
    async initialize(args) {
      n += 1;
      started.push(args);
      return { transactionId: `tx-${n}`, accountNumber: `88800075${String(n).padStart(2, "0")}`, bankCode: "035", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    },
    async verify({ transactionId }) {
      return outcomes.get(transactionId) ?? { found: true, status: "pending", amountKobo: 100000, currency: "NGN", paidAt: null };
    },
  };
  const done = (transactionId, over = {}) => outcomes.set(transactionId, { found: true, status: "success", amountKobo: 100000, currency: "NGN", paidAt: new Date(), ...over });
  const txOf = async (reference) => (await Payment.findOne({ reference })).providerRef;
  const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };

  before(async () => {
    ctx = await startTestServer({ ALATPAY_SECRET_KEY: KEY, ALATPAY_BUSINESS_ID: BUSINESS, PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", REGISTRATION_FEE_NAIRA: "1000", RATE_LIMIT_LOGIN: "500" });
    call = client(ctx.base);
    sup = await createStaff({ role: "super_admin" });
    superCookie = (await logIn(call, sup.email, sup.password)).cookie;
  });
  after(async () => {
    setAlatpay(undefined);
    setPaystack(undefined);
    await ctx.stop();
  });
  beforeEach(async () => {
    started.length = 0;
    outcomes.clear();
    mails.sent = [];
    setAlatpay(fake);
    setPaystack({ enabled: true, async initialize() { return { authorizationUrl: "https://checkout.paystack.test/x", reference: "x" }; }, async verify() { return { found: false }; } });
    setMailer(mails, { notifications: true, appUrl: "https://nmrep.test" });
    await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: null, registrationFeeActive: null } });
  });

  const owner = async () => {
    const res = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return { cookie: res.cookie, id: res.json.user.id, email: res.json.user.email, registration: res.json.registration };
  };
  const start = (o) => call("POST", "/api/payments/registration/initialize", { cookie: o.cookie });
  const verify = (o, reference) => call("POST", "/api/payments/registration/verify", { cookie: o.cookie, body: { reference } });

  it("uses ALATPay when both are set up and nothing was chosen, and says so everywhere", async () => {
    const reference = await call("GET", "/api/reference", {});
    assert.equal(reference.json.registrationFee.gateway, "alatpay");
    const o = await owner();
    assert.equal(o.registration.gateway, "alatpay");
    assert.equal(o.registration.paid, false);
  });

  it("gives the account to transfer to, not a page to visit, and never sends the key anywhere else", async () => {
    const o = await owner();
    const res = await start(o);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.gateway, "alatpay");
    assert.equal(res.json.authorizationUrl, null);
    assert.equal(res.json.amount, 1000);
    assert.match(res.json.transfer.accountNumber, /^88800075\d\d$/);
    assert.equal(res.json.transfer.bankName, "Wema Bank");
    assert.equal(res.json.transfer.bankCode, "035");
    assert.ok(res.json.transfer.expiresAt);
    assert.match(res.json.reference, /^NMREG-[0-9A-F]{16}$/);
    assert.equal(started[0].amountNaira, 1000);
    assert.equal(started[0].orderId, res.json.reference.replace("-", ""), "the dash is left out of the order id");
    assert.equal(started[0].email, o.email);
    assert.ok(started[0].firstName && started[0].lastName);
    assert.ok(!res.text.includes(KEY));
    const stored = await Payment.findOne({ reference: res.json.reference });
    assert.equal(stored.provider, "alatpay");
    assert.match(stored.providerRef, /^tx-\d+$/);
  });

  it("asking again with an open account gives the same account, not a new one", async () => {
    const o = await owner();
    const first = await start(o);
    const again = await start(o);
    assert.equal(again.json.reference, first.json.reference);
    assert.equal(again.json.transfer.accountNumber, first.json.transfer.accountNumber);
    assert.equal(started.length, 1, "ALATPay was asked once");
    const state = await call("GET", "/api/payments/registration", { cookie: o.cookie });
    assert.equal(state.json.pending.transfer.accountNumber, first.json.transfer.accountNumber, "a page that was closed can show it again");
    assert.equal(state.json.pending.gateway, "alatpay");
  });

  it("stays pending until the transfer arrives, then buys the year once and sends the receipt", async () => {
    const o = await owner();
    const { json } = await start(o);
    const waiting = await verify(o, json.reference);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.json.outcome, "pending");
    assert.equal(waiting.json.registration.paid, false);
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie })).status, 402);

    done(await txOf(json.reference));
    mails.sent = [];
    const paid = await verify(o, json.reference);
    assert.equal(paid.json.outcome, "success");
    assert.equal(paid.json.registration.paid, true);
    assert.ok(paid.json.registration.paidUntil);
    assert.equal((await call("GET", "/api/dashboard", { cookie: o.cookie })).status, 200);
    assert.ok(mails.sent.some((m) => m.to === o.email && /receipt/i.test(m.subject)));
    const until = (await User.findById(o.id)).registrationPaidUntil;
    await verify(o, json.reference);
    assert.equal(String((await User.findById(o.id)).registrationPaidUntil), String(until), "checking again buys nothing more");
    assert.equal((await start(o)).status, 409, "already paid");
  });

  it("does not accept a transfer for a different amount or a different currency", async () => {
    const o = await owner();
    const { json } = await start(o);
    done(await txOf(json.reference), { amountKobo: 50000 });
    const res = await verify(o, json.reference);
    assert.equal(res.json.outcome, "failed");
    assert.equal(res.json.registration.paid, false);
  });

  it("recognises a transfer that arrived while the owner was away, when they come back", async () => {
    const o = await owner();
    const { json } = await start(o);
    done(await txOf(json.reference));
    const state = await call("GET", "/api/payments/registration", { cookie: o.cookie });
    assert.equal(state.json.registration.paid, true);
    assert.equal(state.json.pending, null);
    assert.equal(state.json.payments[0].status, "success");
    assert.equal(state.json.payments[0].reference, json.reference);
    assert.equal(state.json.payments[0].transfer, undefined, "no account details in the history");
    assert.equal(state.json.payments[0].providerRef, undefined);
  });

  it("an account that expired unpaid is over, and a new one is asked for", async () => {
    const o = await owner();
    const first = await start(o);
    await Payment.updateOne({ reference: first.json.reference }, { $set: { "transfer.expiresAt": new Date(Date.now() - 1000) } });
    const res = await verify(o, first.json.reference);
    assert.equal(res.json.outcome, "failed");
    const second = await start(o);
    assert.notEqual(second.json.reference, first.json.reference);
    assert.equal(started.length, 2);
  });

  it("answers 503 and records a failed attempt when ALATPay cannot be reached", async () => {
    const o = await owner();
    setAlatpay({ enabled: true, async initialize() { return { unavailable: true }; }, async verify() { return { unavailable: true }; } });
    const res = await start(o);
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "payments_unavailable");
    assert.equal(await Payment.countDocuments({ user: o.id, status: "failed" }), 1);
  });

  it("another owner cannot check this owner's payment", async () => {
    const a = await owner();
    const b = await owner();
    const { json } = await start(a);
    assert.equal((await verify(b, json.reference)).status, 404);
  });
});

describe("the ALATPay webhook", () => {
  let ctx;
  let call;
  const outcomes = new Map();
  const fake = {
    enabled: true,
    async initialize() { return { transactionId: `wh-${Date.now()}-${Math.random()}`, accountNumber: "8880001111", bankCode: "035", expiresAt: new Date(Date.now() + 86_400_000) }; },
    async verify({ transactionId }) { return outcomes.get(transactionId) ?? { found: true, status: "pending", amountKobo: 100000, currency: "NGN", paidAt: null }; },
  };
  before(async () => {
    ctx = await startTestServer({ ALATPAY_SECRET_KEY: KEY, ALATPAY_BUSINESS_ID: BUSINESS, REGISTRATION_FEE_NAIRA: "1000", RATE_LIMIT_LOGIN: "500" });
    call = client(ctx.base);
  });
  after(async () => {
    setAlatpay(undefined);
    await ctx.stop();
  });
  beforeEach(() => {
    setAlatpay(fake);
    setMailer({ enabled: false, async send() { return { ok: false }; } }, { notifications: false });
    outcomes.clear();
  });
  const hook = (body) => fetch(`${ctx.base}/api/webhooks/alatpay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("records a completed payment, but only after checking it with ALATPay itself", async () => {
    const reg = await call("POST", "/api/auth/register", { body: registrationBody() });
    const started = await call("POST", "/api/payments/registration/initialize", { cookie: reg.cookie });
    const payment = await Payment.findOne({ reference: started.json.reference });

    // A message that claims success, while ALATPay says pending: nothing is recorded.
    const liar = await hook({ Value: { Data: { Id: payment.providerRef, Status: "completed", Amount: 1000 } }, Status: true });
    assert.equal(liar.status, 200);
    assert.equal((await Payment.findById(payment._id)).status, "pending");

    outcomes.set(payment.providerRef, { found: true, status: "success", amountKobo: 100000, currency: "NGN", paidAt: new Date() });
    const real = await hook({ Value: { Data: { Id: payment.providerRef, Status: "completed", Amount: 1000 } }, Status: true });
    assert.equal(real.status, 200);
    assert.equal((await Payment.findById(payment._id)).status, "success");
    assert.ok((await User.findOne({ email: reg.json.user.email })).registrationPaidUntil);
  });

  it("answers 200 and does nothing for anything it does not know", async () => {
    for (const body of [{}, { Value: { Data: { Id: "nobody" } } }, { Value: null }, "text", []]) {
      const res = await hook(body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true });
    }
  });
});

describe("the super admin choosing the gateway", () => {
  let ctx;
  let call;
  let superCookie;
  let adminCookie;
  before(async () => {
    ctx = await startTestServer({ ALATPAY_SECRET_KEY: KEY, ALATPAY_BUSINESS_ID: BUSINESS, PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", RATE_LIMIT_LOGIN: "500" });
    call = client(ctx.base);
    const s = await createStaff({ role: "super_admin" });
    superCookie = (await logIn(call, s.email, s.password)).cookie;
    const a = await createStaff({ role: "admin" });
    adminCookie = (await logIn(call, a.email, a.password)).cookie;
  });
  after(async () => {
    setAlatpay(undefined);
    setPaystack(undefined);
    await ctx.stop();
  });

  it("shows both gateways and which are set up, never a key", async () => {
    const res = await call("GET", "/api/admin/settings", { cookie: superCookie });
    const fee = res.json.registrationFee;
    assert.equal(fee.gateway, "alatpay");
    assert.deepEqual(fee.gateways.map((g) => [g.name, g.configured]), [["alatpay", true], ["paystack", true]]);
    assert.ok(!res.text.includes(KEY) && !res.text.includes("sk_test"));
  });

  it("switches at once, in the public fee and for new payments, and can go back", async () => {
    const to = await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: "paystack" } });
    assert.equal(to.status, 200, to.text);
    assert.equal(to.json.registrationFee.gateway, "paystack");
    assert.equal(to.json.registrationFee.gatewayChanged, true);
    assert.equal(to.json.registrationFee.inForce, true);
    assert.equal((await call("GET", "/api/reference", {})).json.registrationFee.gateway, "paystack");

    const back = await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: null } });
    assert.equal(back.json.registrationFee.gateway, "alatpay");
    assert.equal(back.json.registrationFee.gatewayChanged, false);
    assert.equal((await call("GET", "/api/reference", {})).json.registrationFee.gateway, "alatpay");
  });

  it("choosing a gateway that is not set up turns the fee off, and says so, instead of failing owners", async () => {
    const lonely = await startExtraApp({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", RATE_LIMIT_LOGIN: "500" });
    try {
      const c = client(lonely.base);
      const s = await createStaff({ role: "super_admin" });
      const cookie = (await logIn(c, s.email, s.password)).cookie;
      const before = await c("GET", "/api/admin/settings", { cookie });
      assert.equal(before.json.registrationFee.gateway, "paystack", "the only configured one is used by default");
      const chosen = await c("PATCH", "/api/admin/settings", { cookie, body: { paymentGateway: "alatpay" } });
      assert.equal(chosen.json.registrationFee.gateway, "alatpay");
      assert.equal(chosen.json.registrationFee.inForce, false);
      assert.equal((await c("GET", "/api/reference", {})).json.registrationFee.required, false);
    } finally {
      await lonely.stop();
    }
  });

  it("only the super admin, and only the two known gateways", async () => {
    assert.equal((await call("PATCH", "/api/admin/settings", { cookie: adminCookie, body: { paymentGateway: "paystack" } })).status, 403);
    for (const bad of ["flutterwave", "", 5, true]) {
      assert.equal((await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: bad } })).status, 422, String(bad));
    }
  });

  it("is written to the activity log", async () => {
    await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: "paystack" } });
    const { AuditLog } = await import("../src/models/AuditLog.js");
    const entry = await AuditLog.findOne({ action: "settings.update" }).sort({ at: -1 });
    assert.match(entry.summary, /payment gateway: paystack/);
    await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { paymentGateway: null } });
  });
});
