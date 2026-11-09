import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { applyToConfig, loadSettings } from "../src/lib/settings.js";
import { setPaystack } from "../src/lib/paystack.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Setting } from "../src/models/Setting.js";
import { loadConfig } from "../src/config.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

const SECRET = "sk_test_not_a_real_key_for_tests";

let ctx;
let call;
let superCookie;
let adminCookie;

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: SECRET, REGISTRATION_FEE_NAIRA: "1000" });
  call = client(ctx.base);
  superCookie = (await logIn(call, ...Object.values(await credentials("super_admin")))).cookie;
  adminCookie = (await logIn(call, ...Object.values(await credentials("admin")))).cookie;
});
after(async () => {
  setPaystack(undefined);
  await ctx.stop();
});
beforeEach(async () => {
  // Every test starts from the server's own settings.
  await Setting.deleteMany({});
  await call("PATCH", "/api/admin/settings", { cookie: superCookie, body: { registrationFeeNaira: null, registrationPeriodDays: null, registrationFeeActive: null, remindersEnabled: null } });
});

async function credentials(role) {
  const s = await createStaff({ role });
  return { email: s.email, password: s.password };
}
const get = () => call("GET", "/api/admin/settings", { cookie: superCookie });
const patch = (body) => call("PATCH", "/api/admin/settings", { cookie: superCookie, body });

describe("system settings", () => {
  it("shows the settings in force and where they come from, never the Paystack key", async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.json.registrationFee.amountNaira, 1000);
    assert.equal(res.json.registrationFee.periodDays, 365);
    assert.equal(res.json.registrationFee.active, true);
    assert.equal(res.json.registrationFee.keySet, true);
    assert.equal(res.json.registrationFee.keyMode, "test");
    assert.equal(res.json.registrationFee.inForce, true);
    assert.equal(res.json.registrationFee.amountChanged, false);
    assert.ok(!res.text.includes(SECRET), "the key never leaves the server");
    assert.ok(!res.text.includes("sk_"));
  });

  it("only the super admin can see or change them", async () => {
    assert.equal((await call("GET", "/api/admin/settings", { cookie: adminCookie })).status, 403);
    assert.equal((await call("PATCH", "/api/admin/settings", { cookie: adminCookie, body: { registrationFeeNaira: 5 } })).status, 403);
    assert.equal((await call("GET", "/api/admin/settings", {})).status, 401);
    const owner = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal((await call("GET", "/api/admin/settings", { cookie: owner.cookie })).status, 403);
  });

  it("a new fee applies at once to the public fee, to new payments and to the receipt amount", async () => {
    const res = await patch({ registrationFeeNaira: 2500, registrationPeriodDays: 180 });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.registrationFee.amountNaira, 2500);
    assert.equal(res.json.registrationFee.periodDays, 180);
    assert.equal(res.json.registrationFee.amountChanged, true);
    assert.equal(res.json.registrationFee.envAmountNaira, 1000);

    const reference = await call("GET", "/api/reference", {});
    assert.deepEqual(reference.json.registrationFee, { required: true, amount: 2500, currency: "NGN", gateway: "paystack" });

    const asked = [];
    setPaystack({ enabled: true, async initialize(a) { asked.push(a); return { authorizationUrl: "https://checkout.paystack.test/x", reference: a.reference }; }, async verify() { return { found: false }; } });
    const owner = await call("POST", "/api/auth/register", { body: registrationBody() });
    const started = await call("POST", "/api/payments/registration/initialize", { cookie: owner.cookie });
    assert.equal(started.status, 201, started.text);
    assert.equal(started.json.amount, 2500);
    assert.equal(asked[0].amountKobo, 250000, "Paystack is asked for the new amount, in kobo");
  });

  it("pausing the fee stops asking owners to pay, and switching it on again asks them again", async () => {
    const owner = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal((await call("GET", "/api/dashboard", { cookie: owner.cookie })).status, 402);

    const off = await patch({ registrationFeeActive: false });
    assert.equal(off.json.registrationFee.active, false);
    assert.equal(off.json.registrationFee.inForce, false);
    assert.equal(off.json.registrationFee.keySet, true, "pausing does not touch the key");
    assert.equal((await call("GET", "/api/dashboard", { cookie: owner.cookie })).status, 200);
    assert.equal((await call("GET", "/api/reference", {})).json.registrationFee.required, false);

    await patch({ registrationFeeActive: true });
    assert.equal((await call("GET", "/api/dashboard", { cookie: owner.cookie })).status, 402);
  });

  it("null puts a setting back to the server value", async () => {
    await patch({ registrationFeeNaira: 4000 });
    const back = await patch({ registrationFeeNaira: null });
    assert.equal(back.json.registrationFee.amountNaira, 1000);
    assert.equal(back.json.registrationFee.amountChanged, false);
  });

  it("refuses bad values and unknown fields", async () => {
    for (const body of [{ registrationFeeNaira: 5 }, { registrationFeeNaira: 5_000_000 }, { registrationFeeNaira: "lots" }, { registrationPeriodDays: 3 }, { registrationPeriodDays: 4000 }, { registrationFeeActive: "yes" }, { remindersEnabled: 1 }]) {
      const res = await patch(body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.equal((await patch({})).status, 422, "an empty change is refused");
    assert.equal((await patch({ paystackSecretKey: "sk_live_x" })).status, 422, "the key cannot be set here");
  });

  it("is written to the activity log without any secret", async () => {
    await patch({ registrationFeeNaira: 3000, registrationFeeActive: false });
    const entry = await AuditLog.findOne({ action: "settings.update" }).sort({ at: -1 });
    assert.ok(entry);
    assert.match(entry.summary, /registration fee amount: 3000/);
    assert.match(entry.summary, /registration fee on or off: false/);
    assert.ok(!entry.summary.includes("sk_"));
  });

  it("survives a restart: stored settings are laid over the .env values when the server starts", async () => {
    await patch({ registrationFeeNaira: 1800, remindersEnabled: false });
    const fresh = loadConfig({ NODE_ENV: "test", PAYSTACK_SECRET_KEY: SECRET, REGISTRATION_FEE_NAIRA: "1000", MONGODB_URI: "x" });
    assert.equal(fresh.payments.registrationFeeNaira, 1000);
    await loadSettings(fresh);
    assert.equal(fresh.payments.registrationFeeNaira, 1800);
    assert.equal(fresh.reminders.enabled, false);
    assert.equal(fresh.payments.enabled, true);
  });

  it("without a Paystack key nothing is asked of anyone, whatever the switch says", () => {
    const noKey = loadConfig({ NODE_ENV: "test", MONGODB_URI: "x" });
    applyToConfig(noKey, { registrationFeeActive: true });
    assert.equal(noKey.payments.enabled, false);
  });


  describe('on the live server the fee cannot be switched off', () => {
    const prod = (env = {}) => loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'x', ...env });

    it('stays on with no gateway keys at all', () => {
      const none = prod();
      applyToConfig(none, {});
      assert.equal(none.payments.enabled, true);
    });

    it('stays on when the fee was paused in Settings', () => {
      const paused = prod({ PAYSTACK_SECRET_KEY: SECRET });
      applyToConfig(paused, { registrationFeeActive: false });
      assert.equal(paused.payments.enabled, true);
    });

    it('uses a gateway that is set up when the chosen one is not', () => {
      const cfg = prod({ PAYSTACK_SECRET_KEY: SECRET });
      applyToConfig(cfg, { paymentGateway: 'alatpay' });
      assert.equal(cfg.payments.gateway, 'paystack');
      assert.equal(cfg.payments.enabled, true);
    });

    it('is shown to the super admin as locked on, and an owner with no payment is held (402)', async () => {
      const cfg = prod({ PAYSTACK_SECRET_KEY: SECRET });
      applyToConfig(cfg, { registrationFeeActive: false });
      const { registrationState } = await import('../src/lib/payments.js');
      const state = registrationState({ registrationPaidUntil: null }, cfg);
      assert.equal(state.required, true);
      assert.equal(state.paid, false);
    });
  });

});
