import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { parseWat } from "../src/lib/alatpay.js";
import { createPrembly, setPrembly } from "../src/lib/prembly.js";
import { setMailer } from "../src/lib/mailer.js";
import { runCheck } from "../src/lib/verification.js";
import { Business } from "../src/models/Business.js";
import { User } from "../src/models/User.js";
import { VerificationCheck } from "../src/models/VerificationCheck.js";
import { loadConfig } from "../src/config.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Nothing is verified, and no ID is issued, before the registration fee is paid. The fee is ON here (a gateway key is
// set) and the NIN provider is a fake that always finds the person, so any check that runs would pass.

let ctx;
let call;
let admin;
let providerCalls;
const NIN = "12345678901";
const quiet = { log() {}, error() {} };
const record = { status: true, detail: "Verification Successful", response_code: "00", verification: { reference: "ref-1" }, data: { firstname: "Ada", middlename: "", surname: "Obi", telephoneno: "08012345678" } };
const fetchImpl = async () => {
  providerCalls += 1;
  return new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } });
};
const mails = [];

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", PREMBLY_API_KEY: "test-key-not-real", VERIFICATION_HASH_KEY: "h".repeat(40), RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  const s = await createStaff({ role: "admin" });
  admin = (await logIn(call, s.email, s.password)).cookie;
});
after(async () => {
  await ctx.stop();
});
beforeEach(() => {
  providerCalls = 0;
  mails.length = 0;
  setPrembly(createPrembly({ apiKey: "test-key-not-real", baseUrl: "https://api.prembly.test" }, { fetchImpl, log: quiet }));
  setMailer({ enabled: true, send: async (m) => (mails.push(m), { ok: true }) }, { notifications: true, appUrl: "https://nmrep.test" });
});

async function register() {
  const body = registrationBody();
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, res.text);
  return { cookie: res.cookie, email: body.account.email, userId: res.json.user.id, business: res.json.business, registration: res.json.registration };
}
const markPaid = (o) => User.updateOne({ _id: o.userId }, { registrationPaidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });

describe("nothing is verified before the fee is paid", () => {
  it("signing up does not check the NIN, verify the business or issue an ID", async () => {
    const o = await register();
    assert.equal(o.registration.required, true);
    assert.equal(o.registration.paid, false);
    assert.equal(providerCalls, 0, "the provider was not asked");
    const business = await Business.findById(o.business.id);
    assert.equal(business.verificationStatus, "Unverified");
    assert.equal(business.nmrepId, null);
    assert.equal(business.ninMasked.slice(-4).length, 4, "the last four digits are still kept");
    assert.equal(await VerificationCheck.countDocuments({ business: business._id }), 0);
  });

  it("an unpaid owner cannot run a NIN or CAC check (402), and the provider is not asked", async () => {
    const o = await register();
    for (const body of [{ type: "nin", number: NIN, consent: true }, { type: "cac", number: "RC1234567" }]) {
      const res = await call("POST", "/api/verification/checks", { cookie: o.cookie, body });
      assert.equal(res.status, 402, JSON.stringify(res.json));
      assert.equal(res.json.error.code, "payment_required");
    }
    assert.equal(providerCalls, 0);
  });

  it("the check itself refuses an unpaid owner, whoever calls it", async () => {
    const o = await register();
    const user = await User.findById(o.userId);
    const business = await Business.findById(o.business.id);
    const config = loadConfig({ NODE_ENV: "test", MONGODB_URI: "x", PAYSTACK_SECRET_KEY: "sk_test_x", PREMBLY_API_KEY: "k", VERIFICATION_HASH_KEY: "h".repeat(40) });
    config.payments.enabled = true;
    await assert.rejects(runCheck({ config, business, user, input: { type: "nin", number: NIN, consent: true } }), (err) => err.status === 402);
    assert.equal(providerCalls, 0);
  });

  it("once the fee is paid the NIN check works and verifies the business", async () => {
    const o = await register();
    await markPaid(o);
    const res = await call("POST", "/api/verification/checks", { cookie: o.cookie, body: { type: "nin", number: NIN, consent: true } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.check.status, "Passed");
    const business = await Business.findById(o.business.id);
    assert.equal(business.verificationStatus, "Verified");
    assert.match(business.nmrepId, /^NMREP-\d{4}-\d{8}$/);
  });

  it("the admin queue shows the fee, the email, the history and every detail of both checks", async () => {
    const o = await register();
    await markPaid(o);
    await call("POST", "/api/verification/checks", { cookie: o.cookie, body: { type: "nin", number: NIN, consent: true } });
    const queue = await call("GET", "/api/admin/verifications?status=all", { cookie: admin });
    assert.equal(queue.status, 200);
    const item = queue.json.items.find((i) => i.id === o.business.id);
    assert.ok(item.registrationPaidUntil, "the fee state is shown");
    assert.equal(item.emailVerified, false);
    assert.equal(item.accountActive, true);
    assert.ok(item.history.length >= 1);
    assert.equal(item.nin.status, "Passed");
    assert.equal(item.nin.maskedValue.slice(-4), NIN.slice(-4));
    assert.equal(item.nin.reference, "ref-1");
    assert.ok(item.nin.consentAt);
    assert.ok(item.nin.message);
    assert.ok(!JSON.stringify(item).includes(NIN), "the full NIN is never shown");
  });

  it("the admin business list shows who has not paid", async () => {
    const o = await register();
    const list = await call("GET", "/api/admin/businesses", { cookie: admin });
    const row = list.json.items.find((i) => i.id === o.business.id);
    assert.equal(row.registrationPaidUntil, null);
  });
});

describe("password reset", () => {
  const tokenOf = (email) => {
    const m = mails.filter((x) => x.to === email && /Reset your NMREP password/.test(x.subject)).at(-1);
    return /#token=([A-Za-z0-9_-]+)/.exec(m.text)[1];
  };

  it("works end to end for an owner who has not paid: new password signs in, old one does not, and the fee still applies", async () => {
    const o = await register();
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: o.email } })).status, 200);
    const token = tokenOf(o.email);
    const done = await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "BrandNewPass9" } });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal((await call("GET", "/api/auth/me", { cookie: o.cookie, origin: null })).status, 401, "the old session is signed out");
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: o.email, password: "Secret123" } })).status, 401);
    const login = await call("POST", "/api/auth/login", { body: { identifier: o.email, password: "BrandNewPass9" } });
    assert.equal(login.status, 200);
    assert.equal(login.json.registration.paid, false);
    assert.equal((await call("GET", "/api/dashboard", { cookie: login.cookie, origin: null })).status, 402);
    assert.ok(mails.some((m) => m.to === o.email && /password/i.test(m.subject) && /changed/i.test(m.subject + m.text)), "a 'password changed' mail is sent");
  });

  it("the app can reset too and sign in with a token", async () => {
    const o = await register();
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: tokenOf(o.email), newPassword: "AppNewPass77" } })).status, 200);
    const res = await fetch(`${ctx.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-client": "app" }, body: JSON.stringify({ identifier: o.email, password: "AppNewPass77" }) });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).token, "the app gets a bearer token");
  });
});

describe("Nigerian time", () => {
  it("a time from ALATPay without a zone is West Africa Time, not UTC", () => {
    assert.equal(parseWat("2030-01-02T10:00:00").toISOString(), "2030-01-02T09:00:00.000Z");
    assert.equal(parseWat("2030-01-02 10:00:00").toISOString(), "2030-01-02T09:00:00.000Z");
    assert.equal(parseWat("2030-01-02T10:00:00.123").toISOString(), "2030-01-02T09:00:00.123Z");
    assert.equal(parseWat("2030-01-02T10:00:00Z").toISOString(), "2030-01-02T10:00:00.000Z", "a stated zone is kept");
    assert.equal(parseWat("2030-01-02T10:00:00+01:00").toISOString(), "2030-01-02T09:00:00.000Z");
    assert.ok(Number.isNaN(parseWat("").getTime()));
  });
});
