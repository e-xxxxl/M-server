import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { setMailer } from "../src/lib/mailer.js";
import { setPaystack } from "../src/lib/paystack.js";
import { createPrembly, setPrembly } from "../src/lib/prembly.js";
import { client, registrationBody, startTestServer } from "./helpers.js";

// Alerts to the NMREP staff inbox (admin@nmrep.org): a new registration, a fee paid, a check that needs a reviewer, and
// the website contact form. Never a NIN, a password or the owner's phone or email.

let ctx;
let call;
const sent = [];
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
const ninHit = (name) => async () => new Response(JSON.stringify({ status: true, response_code: "00", data: { firstname: name[0], surname: name[1], telephoneno: "08000000000" }, verification: { reference: "r" } }), { status: 200 });
const quiet = { log() {}, error() {} };
const wait = () => new Promise((r) => setTimeout(r, 60));
const toStaff = () => sent.filter((m) => m.to === "admin@nmrep.org");

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests", REGISTRATION_FEE_NAIRA: "1000", PREMBLY_API_KEY: "k", VERIFICATION_HASH_KEY: "h".repeat(40) });
  call = client(ctx.base);
});
after(async () => {
  setPaystack(undefined);
  setPrembly(createPrembly(null));
  await ctx.stop();
});
beforeEach(() => {
  sent.length = 0;
  outcomes.clear();
  setPaystack(fakePaystack);
  setPrembly(createPrembly(null));
  setMailer({ enabled: true, send: async (m) => (sent.push(m), { ok: true }) }, { notifications: true, appUrl: "https://nmrep.test" });
});

const register = async (business = {}, account = {}) => {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business, account }) });
  assert.equal(res.status, 201, res.text);
  return res;
};

describe("a new registration", () => {
  it("is emailed to the staff inbox with the business, owner, place and verification state, and a link to it", async () => {
    const res = await register({ businessName: "Alert Traders", state: "Lagos" });
    await wait();
    const mail = toStaff().find((m) => /New registration/.test(m.subject));
    assert.ok(mail, JSON.stringify(sent.map((m) => m.subject)));
    assert.match(mail.subject, /Alert Traders/);
    assert.match(mail.text, /Owner: Ada Obi/);
    assert.match(mail.text, /Lagos/);
    assert.match(mail.text, new RegExp(`/admin/businesses/detail/\\?id=${res.json.business.id}`));
  });

  it("never carries the NIN, the password, or the owner's phone or email", async () => {
    const res = await register({}, { nin: "98765432109", password: "SecretPass99" });
    await wait();
    const text = JSON.stringify(toStaff());
    assert.ok(!text.includes("98765432109") && !text.includes("SecretPass99"));
    assert.ok(!text.includes(res.json.user.email) && !text.includes(res.json.user.phone));
  });

  it("says when the NIN matched and the business was verified", async () => {
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: ninHit(["Ada", "Obi"]), log: quiet }));
    await register();
    await wait();
    assert.match(toStaff().find((m) => /New registration/.test(m.subject)).text, /Verified \(the NIN matched\)/);
  });
});

describe("a registration fee", () => {
  it("is emailed when it is paid, with the amount, years, gateway and reference", async () => {
    const res = await register({ businessName: "Payer Ltd" });
    const init = await call("POST", "/api/payments/registration/initialize", { cookie: res.cookie, body: { years: 3 } });
    outcomes.set(init.json.reference, { found: true, status: "success", amountKobo: 300_000, currency: "NGN", paidAt: new Date(), reference: init.json.reference });
    await call("POST", "/api/payments/registration/verify", { cookie: res.cookie, body: { reference: init.json.reference } });
    await wait();
    const mail = toStaff().find((m) => /fee received/i.test(m.subject));
    assert.ok(mail);
    assert.match(mail.subject, /Payer Ltd/);
    assert.match(mail.text, /₦3,000 for 3 years/);
    assert.match(mail.text, /Paystack/);
    assert.match(mail.text, new RegExp(init.json.reference));
  });

  it("is not emailed again when the same payment is checked twice", async () => {
    const res = await register();
    const init = await call("POST", "/api/payments/registration/initialize", { cookie: res.cookie, body: {} });
    outcomes.set(init.json.reference, { found: true, status: "success", amountKobo: 100_000, currency: "NGN", paidAt: new Date(), reference: init.json.reference });
    for (let i = 0; i < 3; i += 1) await call("POST", "/api/payments/registration/verify", { cookie: res.cookie, body: { reference: init.json.reference } });
    await wait();
    assert.equal(toStaff().filter((m) => /fee received/i.test(m.subject)).length, 1);
  });
});

describe("a check that needs a reviewer", () => {
  it("is emailed when the NIN record is in a different name, and not when it matches or is not found", async () => {
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: ninHit(["Emeka", "Eze"]), log: quiet }));
    await register({ businessName: "Mismatch Co" });
    await wait();
    const mail = toStaff().find((m) => /Needs a reviewer/.test(m.subject));
    assert.ok(mail);
    assert.match(mail.text, /NIN check: a record was found in a name that does not match/);
    assert.match(mail.text, /\/admin\/verification\//);

    sent.length = 0;
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: ninHit(["Ada", "Obi"]), log: quiet }));
    await register();
    setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: async () => new Response("{}", { status: 400 }), log: quiet }));
    await register();
    await wait();
    assert.equal(toStaff().filter((m) => /Needs a reviewer/.test(m.subject)).length, 0);
  });
});

describe("the website contact form", () => {
  it("goes to the same inbox", async () => {
    const res = await call("POST", "/api/contact", { body: { name: "Visitor", email: "v@example.com", phone: "", subject: "A question", message: "How do I renew?", website: "" } });
    assert.equal(res.status, 201);
    await wait();
    assert.equal(toStaff().filter((m) => /Website enquiry/.test(m.subject)).length, 1);
  });
});

describe("the settings", () => {
  it("can send to several addresses, or none", () => {
    const many = loadConfig({ NODE_ENV: "test", STAFF_ALERT_EMAIL: "a@nmrep.org, b@nmrep.org" });
    assert.deepEqual(many.staffAlerts.to, ["a@nmrep.org", "b@nmrep.org"]);
    assert.equal(many.contact.inbox, "a@nmrep.org");
    assert.deepEqual(loadConfig({ NODE_ENV: "test", STAFF_ALERT_EMAIL: "" }).staffAlerts.to, []);
    assert.equal(loadConfig({ NODE_ENV: "test", STAFF_ALERT_EMAIL: "a@nmrep.org", CONTACT_EMAIL: "help@nmrep.org" }).contact.inbox, "help@nmrep.org");
  });

  it("defaults to admin@nmrep.org", () => {
    assert.deepEqual(ctx.config.staffAlerts.to, ["admin@nmrep.org"]);
    assert.equal(ctx.config.contact.inbox, "admin@nmrep.org");
  });
});
