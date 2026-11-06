import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { namesMatch, phoneTail } from "../src/lib/name-match.js";
import { createPrembly, setPrembly } from "../src/lib/prembly.js";
import { setMailer } from "../src/lib/mailer.js";
import { Business } from "../src/models/Business.js";
import { Notification } from "../src/models/Notification.js";
import { VerificationCheck } from "../src/models/VerificationCheck.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Automated checks through the provider (NIN and CAC). The provider is replaced by a fake HTTP layer,
// so the real client code (URLs, headers, bodies, reading the answer) is exercised without any network or cost.

let ctx;
let call;
let admin;
const NIN = "12345678901";
const quiet = { log() {}, error() {} };

// What the fake provider is told to answer, and what it was asked.
let calls;
let answer;
const hit = (data, extra = {}) => ({ status: 200, json: { status: true, detail: "Verification Successful", response_code: "00", data, ...extra } });
const fetchImpl = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, headers: init.headers, body });
  const r = await answer(new URL(url).pathname, body);
  if (r instanceof Error) throw r;
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
};
const ninRecord = (over = {}) => hit({ firstname: "Ada", middlename: "Chika", surname: "Obi", telephoneno: "08012345678", birthdate: "1990-01-01", residence_address: "SECRET ADDRESS", photo: "BASE64PHOTO", ...over }, { verification: { reference: "ref-nin-1" } });

before(async () => {
  ctx = await startTestServer({ PREMBLY_API_KEY: "test-key-not-real", VERIFICATION_HASH_KEY: "h".repeat(40), VERIFICATION_MAX_PER_TYPE_PER_DAY: "3", VERIFICATION_MAX_PER_DAY: "8" });
  call = client(ctx.base);
  const s = await createStaff({ role: "admin" });
  admin = (await logIn(call, s.email, s.password)).cookie;
});
after(async () => {
  await ctx.stop();
});
beforeEach(() => {
  calls = [];
  answer = () => ({ status: 400, json: {} });
  setPrembly(createPrembly({ apiKey: "test-key-not-real", baseUrl: "https://api.prembly.test" }, { fetchImpl, log: quiet }));
  setMailer({ enabled: false, send: async () => ({ ok: false }) });
});

async function owner(business = {}, account = {}) {
  // Signing up runs the NIN check when the provider answers. These tests run checks themselves, so the provider is
  // "down" while signing up and nothing is recorded or counted at that point.
  const keep = answer;
  answer = () => ({ status: 503, json: {} });
  const reg = await call("POST", "/api/auth/register", { body: registrationBody({ account, business }) });
  answer = keep;
  calls = [];
  assert.equal(reg.status, 201, reg.text);
  return { cookie: reg.cookie, user: reg.json.user, business: reg.json.business, body: null };
}
/** The provider's record carrying this owner's own phone number, in the local form. */
const ownPhone = (o) => "0" + phoneTail(o.user.phone);
const run = (o, body) => call("POST", "/api/verification/checks", { cookie: o.cookie, body });

describe("name matching", () => {
  it("matches the same name in any order and with extra middle names, and nothing looser", () => {
    assert.equal(namesMatch("Ada Chika Obi", "Obi Ada"), true);
    assert.equal(namesMatch("ADA OBI", "ada obi"), true);
    assert.equal(namesMatch("Adaobi", "Ada Obi"), false);
    assert.equal(namesMatch("Ada", "Ada Obi"), false, "a single first name is not enough");
    assert.equal(namesMatch("Ada Eze", "Ada Obi"), false);
    assert.equal(namesMatch("", "Ada Obi"), false);
    assert.equal(namesMatch("OBI FABRICS LIMITED", "Obi Fabrics", { dropCompanyWords: true }), true);
    assert.equal(namesMatch("Obi Fabrics Nigeria Ltd", "obi fabrics & co", { dropCompanyWords: true }), true);
    assert.equal(namesMatch("Obi Textiles Limited", "Obi Fabrics", { dropCompanyWords: true }), false);
    assert.equal(phoneTail("+234 801 234 5678"), phoneTail("08012345678"));
  });
});

describe("the provider client", () => {
  it("sends the key only in a header, to the documented paths, and keeps only the fields we need", async () => {
    answer = (path) => (path.endsWith("vnin-basic") ? ninRecord() : { status: 400, json: {} });
    const p = createPrembly({ apiKey: "k-1", baseUrl: "https://api.prembly.test" }, { fetchImpl, log: quiet });
    const r = await p.nin(NIN);
    assert.deepEqual(r, { found: true, reference: "ref-nin-1", person: { firstName: "Ada", middleName: "Chika", lastName: "Obi", phone: "08012345678" } });
    assert.equal(calls[0].url, "https://api.prembly.test/verification/vnin-basic");
    assert.equal(calls[0].headers["x-api-key"], "k-1");
    assert.deepEqual(calls[0].body, { number: NIN });
    assert.ok(!JSON.stringify(r).includes("SECRET ADDRESS") && !JSON.stringify(r).includes("BASE64PHOTO"), "dropped everything else");

    assert.equal(p.bvn, undefined, "BVN is not checked");
    assert.equal(p.tin, undefined, "TIN is not checked");

    answer = () => hit({ company_name: "OBI FABRICS LTD", company_status: "Active", directors: { a: 1 } });
    const c = await p.cac({ number: "1234567", companyType: "RC", companyName: "Obi Fabrics" });
    assert.equal(c.company.name, "OBI FABRICS LTD");
    assert.deepEqual(calls.at(-1).body, { rc_number: "1234567", company_type: "RC", company_name: "Obi Fabrics" });
    assert.equal(calls.at(-1).url, "https://api.prembly.test/verification/cac/basic");
  });

  it("treats a refusal of our own key, a rate limit, a server error and a network failure as unavailable, and a normal miss as not found", async () => {
    const p = createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl, log: quiet });
    for (const status of [401, 402, 403, 429, 500, 503]) {
      answer = () => ({ status, json: { detail: "x" } });
      assert.deepEqual(await p.nin(NIN), { unavailable: true }, `HTTP ${status}`);
    }
    answer = () => new Error("network down");
    assert.deepEqual(await p.nin(NIN), { unavailable: true });
    answer = () => ({ status: 400, json: {} });
    assert.equal((await p.nin(NIN)).found, false);
    answer = () => ({ status: 200, json: { status: false, response_code: "01" } });
    assert.equal((await p.nin(NIN)).found, false);
    assert.deepEqual(await createPrembly(null).nin(NIN), { unavailable: true }, "off without a key");
  });
});

describe("Prembly test mode (sandbox)", () => {
  // The shape below is what Prembly's test mode really answers for a NIN: made up data, "is_sandbox": true.
  const sandboxNin = {
    status: true,
    response_code: "00",
    message: "Verification successful (SANDBOX MODE)",
    data: { nin: "56182742701", surname: "AMANDA", firstname: "GRACE", middlename: "CHIMAMANDA", telephoneno: "07082078516", gender: "f" },
    billing_info: { was_charged: false, amount: 0, currency: "NGN" },
    verification: { status: "VERIFIED", reference: "e0d0bb6f-5988-4068-99da-8bb2c440b597" },
    is_sandbox: true,
  };
  const fetchSandbox = async () => ({ status: 200, ok: true, json: async () => sandboxNin });

  it("reads a test mode answer like a normal one outside production", async () => {
    const p = createPrembly({ apiKey: "test-key-not-real", baseUrl: "https://api.prembly.test", allowSandbox: true }, { fetchImpl: fetchSandbox, log: quiet });
    const r = await p.nin("56182742701");
    assert.equal(r.found, true);
    assert.deepEqual(r.person, { firstName: "GRACE", middleName: "CHIMAMANDA", lastName: "AMANDA", phone: "07082078516" });
  });

  it("refuses a test mode answer in production, so made up data is never recorded as a real check", async () => {
    let logged = "";
    const p = createPrembly({ apiKey: "test-key-not-real", baseUrl: "https://api.prembly.test", allowSandbox: false }, { fetchImpl: fetchSandbox, log: { error: (m) => (logged += m) } });
    assert.deepEqual(await p.nin("56182742701"), { unavailable: true });
    assert.match(logged, /sandbox mode/);
    assert.ok(!logged.includes("56182742701") && !logged.includes("GRACE"), "the log never holds the number or the data");
  });
});

describe("running a check", () => {
  it("lists the two checks (NIN required, CAC only for registered businesses) and says why CAC cannot be run yet", async () => {
    const o = await owner();
    const res = await call("GET", "/api/verification", { cookie: o.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    assert.deepEqual(res.json.checks.map((c) => c.type), ["nin", "cac"]);
    const by = Object.fromEntries(res.json.checks.map((c) => [c.type, c]));
    assert.equal(by.nin.applicable, true);
    assert.equal(by.nin.needsNumber, true);
    assert.equal(by.nin.required, true);
    assert.equal(by.cac.required, false);
    assert.equal(by.cac.applicable, false);
    assert.match(by.cac.reason, /CAC registration number/);
    assert.deepEqual(res.json.nin, { provided: true, masked: "*******8901" });
    assert.equal(by.nin.result, null);
    assert.equal(calls.length, 0, "listing never calls the provider");
  });

  it("a NIN that matches passes, verifies the business at once with a NMREP ID, and stores no NIN, name, address or photo", async () => {
    const o = await owner();
    answer = () => ninRecord({ telephoneno: ownPhone(o) });
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.check.status, "Passed");
    assert.equal(res.json.check.maskedValue, "*******8901");
    assert.equal(res.json.verificationStatus, "Verified");
    assert.ok(!res.text.includes(NIN) && !res.text.includes("Chika") && !res.text.includes("SECRET"), "the response holds nothing from the record");

    const stored = JSON.stringify(await VerificationCheck.find({}).lean());
    for (const secret of [NIN, "Chika", "SECRET ADDRESS", "BASE64PHOTO", "1990-01-01", ownPhone(o)]) assert.ok(!stored.includes(secret), `database does not hold ${secret}`);
    const row = await VerificationCheck.findOne({ owner: o.user.id });
    assert.equal(row.nameMatch, true);
    assert.equal(row.phoneMatch, true);
    assert.equal(row.valueHash.length, 64);
    assert.ok(row.consentAt);

    const business = await Business.findOne({ owner: o.user.id });
    assert.equal(business.verificationStatus, "Verified");
    assert.match(business.nmrepId, /^NMREP-\d{4}-\d{8}$/);
    assert.match(business.verificationHistory.at(-1).note, /NIN confirmed automatically/);
    assert.equal(await Notification.countDocuments({ user: o.user.id, title: /is verified/ }), 1);

    const list = await call("GET", "/api/verification", { cookie: o.cookie });
    assert.equal(list.json.checks[0].result.status, "Passed");
    assert.equal(list.json.verificationStatus, "Verified");
  });

  it("a record in a different name needs review and does not change the status", async () => {
    const o = await owner();
    answer = () => ninRecord({ firstname: "Emeka", middlename: "", surname: "Eze" });
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 201);
    assert.equal(res.json.check.status, "Needs review");
    assert.equal(res.json.verificationStatus, "Unverified");
    assert.ok(!res.text.includes("Emeka"), "the owner is not told whose record it is");
    assert.equal((await VerificationCheck.findOne({ owner: o.user.id })).nameMatch, false);
  });

  it("a number the provider cannot find is Not found, with a plain message", async () => {
    const o = await owner();
    answer = () => ({ status: 400, json: {} });
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 201);
    assert.equal(res.json.check.status, "Not found");
    assert.match(res.json.check.message, /could not find/);
  });

  it("needs the agreement and a well formed number, and refuses anything else", async () => {
    const o = await owner();
    const noConsent = await run(o, { type: "nin", number: NIN });
    assert.equal(noConsent.status, 422);
    assert.ok(noConsent.json.error.fields.consent);
    const notTrue = await run(o, { type: "nin", number: NIN, consent: false });
    assert.equal(notTrue.status, 422);
    const short = await run(o, { type: "nin", number: "123", consent: true });
    assert.ok(short.json.error.fields.number);
    const spaces = await run(o, { type: "nin", number: "1234 5678 901", consent: true });
    assert.equal(spaces.status, 422);
    const asNumber = await run(o, { type: "nin", number: 12345678901, consent: true });
    assert.equal(asNumber.status, 422);
    assert.equal((await run(o, { type: "passport", number: NIN })).status, 422);
    assert.equal((await run(o, {})).status, 422);
    assert.equal((await run(o, { type: "cac", number: "RC123" })).status, 422, "unknown field");
    assert.equal(calls.length, 0, "nothing reached the provider");
  });

  it("the same number that already passed is answered from the record without a second provider call", async () => {
    const o = await owner();
    answer = () => ninRecord();
    await run(o, { type: "nin", number: NIN, consent: true });
    const again = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(again.status, 201);
    assert.equal(again.json.check.status, "Passed");
    assert.equal(calls.length, 1);
    assert.equal(await VerificationCheck.countDocuments({ owner: o.user.id }), 1);
  });

  it("limits attempts per type per business per day, and each type has its own allowance", async () => {
    const o = await owner({ hasCac: "Yes", cacNumber: "RC1234567" });
    answer = () => ({ status: 400, json: {} });
    for (let i = 0; i < 3; i++) assert.equal((await run(o, { type: "nin", number: `1000000000${i}`, consent: true })).status, 201);
    const fourth = await run(o, { type: "nin", number: "10000000009", consent: true });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.json.error.code, "check_limit");
    assert.equal(calls.length, 3, "a refused attempt never reaches the provider");

    // The CAC check has its own allowance of 3.
    for (let i = 0; i < 3; i++) assert.equal((await run(o, { type: "cac" })).status, 201);
    const fourthCac = await run(o, { type: "cac" });
    assert.equal(fourthCac.status, 429);
    assert.equal(calls.length, 6);
  });

  it("when the provider is unavailable the owner gets a retry message and nothing is stored or counted", async () => {
    const o = await owner();
    answer = () => ({ status: 503, json: {} });
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "verification_unavailable");
    assert.equal(await VerificationCheck.countDocuments({ owner: o.user.id }), 0);
    answer = () => ninRecord();
    assert.equal((await run(o, { type: "nin", number: NIN, consent: true })).status, 201);
  });

  it("is off, with the same plain answer, when the key or the hash secret is missing", async () => {
    const o = await owner();
    setPrembly(createPrembly(null));
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "verification_unavailable");
    const list = await call("GET", "/api/verification", { cookie: o.cookie });
    assert.equal(list.json.available, false);
  });

  it("checks the CAC number from the profile against the register and compares the registered name", async () => {
    const o = await owner({ hasCac: "Yes", cacNumber: "RC1234567" });
    answer = (path, body) => (path.endsWith("/cac/basic") ? hit({ company_name: "OBI FABRICS LIMITED", company_status: "Active", directors: { x: "PRIVATE" }, email_address: "private@x.com" }, { verification: { reference: "ref-cac" } }) : { status: 400, json: {} });
    const res = await run(o, { type: "cac" });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.check.status, "Passed");
    assert.equal(calls[0].body.rc_number, "1234567", "the RC prefix is not sent");
    assert.equal(calls[0].body.company_type, "RC");
    const row = await VerificationCheck.findOne({ owner: o.user.id });
    assert.equal(row.registeredName, "OBI FABRICS LIMITED");
    assert.ok(!JSON.stringify(row).includes("PRIVATE") && !JSON.stringify(row).includes("private@x.com"));
  });

  it("a struck-off company or a different registered name needs review", async () => {
    const o = await owner({ hasCac: "Yes", cacNumber: "RC1234567" });
    answer = () => hit({ company_name: "OBI FABRICS LIMITED", company_status: "Inactive" });
    assert.equal((await run(o, { type: "cac" })).json.check.status, "Needs review");
    const p = await owner({ hasCac: "Yes", cacNumber: "RC7654321" });
    answer = () => hit({ company_name: "SOMETHING ELSE LTD", company_status: "Active" });
    assert.equal((await run(p, { type: "cac" })).json.check.status, "Needs review");
  });

  it("uses the right register code for the business type, and says when the type is not registered with the CAC", async () => {
    const bn = await owner({ businessType: "Business name (sole owner or partnership)", hasCac: "Yes", cacNumber: "BN 998877" });
    answer = () => hit({ company_name: "Obi Fabrics", company_status: "Active" });
    await run(bn, { type: "cac" });
    assert.equal(calls.at(-1).body.company_type, "BN");
    assert.equal(calls.at(-1).body.rc_number, "998877");

    const none = await owner({ businessType: "Not yet registered with the CAC", cacNumber: "RC111" });
    const res = await run(none, { type: "cac" });
    assert.equal(res.status, 422);
    assert.match(res.json.error.fields.type, /not registered with the CAC/);
  });

  it("BVN and TIN are not offered: both are refused", async () => {
    const o = await owner({ hasTin: "Yes", tin: "12345678-0001" });
    assert.equal((await run(o, { type: "bvn", number: "22334455667", consent: true })).status, 422);
    assert.equal((await run(o, { type: "tin" })).status, 422);
    assert.equal(calls.length, 0);
    assert.ok(!(await call("GET", "/api/verification", { cookie: o.cookie })).text.toLowerCase().includes("bvn"));
  });

  it("a business with no CAC number is told the CAC check is not needed", async () => {
    const o = await owner({ hasCac: "No" });
    const by = Object.fromEntries((await call("GET", "/api/verification", { cookie: o.cookie })).json.checks.map((c) => [c.type, c]));
    assert.equal(by.cac.applicable, false);
    assert.match(by.cac.reason, /Not needed/);
    assert.equal(by.nin.applicable, true);
  });

  it("is for business owners only", async () => {
    assert.equal((await call("GET", "/api/verification")).status, 401);
    assert.equal((await call("GET", "/api/verification", { cookie: admin })).status, 403);
    assert.equal((await call("POST", "/api/verification/checks", { cookie: admin, body: { type: "cac" } })).status, 403);
  });

  it("two checks of the same type at the same moment run the provider once", async () => {
    const o = await owner();
    let release;
    const gate = new Promise((r) => (release = r));
    answer = async () => {
      await gate;
      return ninRecord();
    };
    const first = run(o, { type: "nin", number: NIN, consent: true });
    // Wait until the first request is really inside the provider call, however slow the machine is.
    for (let waited = 0; calls.length === 0 && waited < 60_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, "the first request reached the provider");
    const second = await run(o, { type: "nin", number: "99999999999", consent: true });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "in_progress");
    release();
    assert.equal((await first).status, 201);
  });
});

describe("what reviewers see", () => {
  it("shows the outcome, the comparisons and a warning when another business uses the same number, never the number or the names", async () => {
    const a = await owner({ businessName: "Alpha Traders" }, { fullName: "Ada Obi" });
    const b = await owner({ businessName: "Beta Traders" }, { fullName: "Ada Obi" });
    // A number no other test used, so the count is only about these two businesses.
    const shared = "55555555555";
    answer = () => ninRecord({ telephoneno: ownPhone(a) });
    await run(a, { type: "nin", number: shared, consent: true });
    await run(b, { type: "nin", number: shared, consent: true });

    const detail = await call("GET", `/api/admin/businesses/${a.business.id}`, { cookie: admin });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.automatedChecksAvailable, true);
    const [check] = detail.json.verificationChecks;
    assert.equal(check.type, "nin");
    assert.equal(check.status, "Passed");
    assert.equal(check.nameMatch, true);
    assert.equal(check.phoneMatch, true);
    assert.equal(check.otherBusinessesWithSameNumber, 1);
    assert.equal(check.maskedValue, "*******5555");
    assert.ok(!detail.text.includes(shared) && !detail.text.includes("valueHash") && !detail.text.includes("Chika"));

    const ownerList = await call("GET", "/api/verification", { cookie: a.cookie });
    assert.ok(!ownerList.text.includes("otherBusinessesWithSameNumber"), "owners never see duplicate signals");
  });

  it("an administrator can still change the automatic status afterwards", async () => {
    const o = await owner();
    answer = () => ninRecord();
    await run(o, { type: "nin", number: NIN, consent: true });
    const set = await call("POST", `/api/admin/businesses/${o.business.id}/status`, { cookie: admin, body: { status: "Rejected", note: "Documents do not match." } });
    assert.equal(set.status, 200);
    assert.equal(set.json.business.verificationStatus, "Rejected");
    assert.ok(set.json.business.nmrepId, "the ID issued at verification stays on file");
  });
});

describe("deleting an account", () => {
  it("removes the owner's checks", async () => {
    const o = await owner();
    answer = () => ninRecord();
    await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(await VerificationCheck.countDocuments({ owner: o.user.id }), 1);
    const del = await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Secret123" } });
    assert.equal(del.status, 204);
    assert.equal(await VerificationCheck.countDocuments({ owner: o.user.id }), 0);
  });
});

describe("the NIN at sign-up", () => {
  const registerWith = (account = {}, business = {}) => call("POST", "/api/auth/register", { body: registrationBody({ account, business }) });

  it("is required, with an agreement, and must be 11 digits", async () => {
    for (const account of [{ nin: undefined }, { nin: "123" }, { nin: "1234 5678 901" }, { nin: 12345678901 }, { ninConsent: false }, { ninConsent: undefined }]) {
      const res = await registerWith(account);
      assert.equal(res.status, 422, JSON.stringify(account));
      assert.ok(res.json.error.fields["account.nin"] || res.json.error.fields["account.ninConsent"], JSON.stringify(res.json.error.fields));
    }
    assert.equal(calls.length, 0);
  });

  it("is checked at sign-up when automated checks are on, and only its last four digits and a fingerprint are kept", async () => {
    answer = (_p, _b) => ninRecord();
    const res = await registerWith({ nin: "11122233344", phone: "+2348099911122" });
    assert.equal(res.status, 201, res.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.number, "11122233344");
    assert.equal(res.json.business.ninProvided, true);
    assert.equal(res.json.business.ninMasked, "*******3344");
    assert.ok(!res.text.includes("11122233344"), "the number is never returned");
    const row = await VerificationCheck.findOne({ owner: res.json.user.id });
    assert.equal(row.type, "nin");
    assert.equal(row.status, "Passed");
    const stored = await Business.findOne({ owner: res.json.user.id }).select("+ninHash").lean();
    assert.equal(stored.ninHash.length, 64);
    assert.ok(!JSON.stringify(stored).includes("11122233344"), "the database does not hold the number");
    assert.ok(!JSON.stringify(res.json).includes("ninHash"));
  });

  it("never fails or slows sign-up when the provider is down, and the owner can run the check later", async () => {
    answer = () => ({ status: 503, json: {} });
    const res = await registerWith({ nin: "22233344455", phone: "+2348099911133" });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.business.ninProvided, true);
    assert.equal(await VerificationCheck.countDocuments({ owner: res.json.user.id }), 0);
    answer = () => ninRecord();
    const later = await run({ cookie: res.cookie }, { type: "nin", number: "22233344455", consent: true });
    assert.equal(later.status, 201);
  });

  it("is still kept (last four digits only) when automated checks are off", async () => {
    setPrembly(createPrembly(null));
    const res = await registerWith({ nin: "33344455566", phone: "+2348099911144" });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.business.ninMasked, "*******5566");
    assert.equal(await VerificationCheck.countDocuments({ owner: res.json.user.id }), 0);
  });
});

describe("Verified needs the NIN checked", () => {
  const setStatus = (o, status) => call("POST", `/api/admin/businesses/${o.business.id}/status`, { cookie: admin, body: { status, note: "Reviewed." } });

  it("refuses Verified until a NIN check has found a record, then allows it", async () => {
    const o = await owner();
    const refused = await setStatus(o, "Verified");
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "nin_required");
    assert.equal((await setStatus(o, "Pending Verification")).status, 200, "other statuses are not held back");

    answer = () => ({ status: 400, json: {} });
    await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal((await setStatus(o, "Verified")).status, 409, "a number the provider could not find is not enough");

    answer = () => ninRecord({ firstname: "Emeka", middlename: "", surname: "Eze" });
    await run(o, { type: "nin", number: "99988877766", consent: true });
    const ok = await setStatus(o, "Verified");
    assert.equal(ok.status, 200, "a record in a different name is for the reviewer to judge");
    assert.ok(ok.json.business.nmrepId);
  });

  it("is not enforced while automated checks are off, so manual review keeps working", async () => {
    const o = await owner();
    setPrembly(createPrembly(null));
    assert.equal((await setStatus(o, "Verified")).status, 200);
  });
});
