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

// Automated checks through the provider (NIN, BVN, CAC, TIN). The provider is replaced by a fake HTTP layer,
// so the real client code (URLs, headers, bodies, reading the answer) is exercised without any network or cost.

let ctx;
let call;
let admin;
const NIN = "12345678901";
const BVN = "22334455667";
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
  const reg = await call("POST", "/api/auth/register", { body: registrationBody({ account, business }) });
  assert.equal(reg.status, 201, reg.text);
  return { cookie: reg.cookie, user: reg.json.user, business: reg.json.business, body: null };
}
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

    answer = () => hit({ firstName: "A", middleName: "", lastName: "B", dateOfBirth: "01-Jan-2000", phoneNumber: "0801" });
    await p.bvn(BVN);
    assert.equal(calls.at(-1).url, "https://api.prembly.test/verification/bvn_validation");

    answer = () => hit({ company_name: "OBI FABRICS LTD", company_status: "Active", directors: { a: 1 } });
    const c = await p.cac({ number: "1234567", companyType: "RC", companyName: "Obi Fabrics" });
    assert.equal(c.company.name, "OBI FABRICS LTD");
    assert.deepEqual(calls.at(-1).body, { rc_number: "1234567", company_type: "RC", company_name: "Obi Fabrics" });
    assert.equal(calls.at(-1).url, "https://api.prembly.test/verification/cac/basic");

    answer = () => hit({ taxpayer_name: "Obi Fabrics" });
    await p.tin("1234567-0001");
    assert.deepEqual(calls.at(-1).body, { number: "1234567-0001", channel: "TIN" });
    assert.equal(calls.at(-1).url, "https://api.prembly.test/verification/tin");
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

describe("running a check", () => {
  it("lists the four checks and says why CAC and TIN cannot be run until the profile has the numbers", async () => {
    const o = await owner();
    const res = await call("GET", "/api/verification", { cookie: o.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.available, true);
    assert.deepEqual(res.json.checks.map((c) => c.type), ["nin", "bvn", "cac", "tin"]);
    const by = Object.fromEntries(res.json.checks.map((c) => [c.type, c]));
    assert.equal(by.nin.applicable, true);
    assert.equal(by.nin.needsNumber, true);
    assert.equal(by.cac.applicable, false);
    assert.match(by.cac.reason, /CAC registration number/);
    assert.equal(by.tin.applicable, false);
    assert.equal(by.nin.result, null);
    assert.equal(calls.length, 0, "listing never calls the provider");
  });

  it("a NIN that matches passes, moves the business to Pending Verification, and stores no NIN, name, address or photo", async () => {
    const o = await owner();
    answer = () => ninRecord();
    const res = await run(o, { type: "nin", number: NIN, consent: true });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.check.status, "Passed");
    assert.equal(res.json.check.maskedValue, "*******8901");
    assert.equal(res.json.verificationStatus, "Pending Verification");
    assert.ok(!res.text.includes(NIN) && !res.text.includes("Chika") && !res.text.includes("SECRET"), "the response holds nothing from the record");

    const stored = JSON.stringify(await VerificationCheck.find({}).lean());
    for (const secret of [NIN, "Chika", "SECRET ADDRESS", "BASE64PHOTO", "1990-01-01", "08012345678"]) assert.ok(!stored.includes(secret), `database does not hold ${secret}`);
    const row = await VerificationCheck.findOne({ owner: o.user.id });
    assert.equal(row.nameMatch, true);
    assert.equal(row.phoneMatch, true);
    assert.equal(row.valueHash.length, 64);
    assert.ok(row.consentAt);

    const business = await Business.findOne({ owner: o.user.id });
    assert.equal(business.verificationStatus, "Pending Verification");
    assert.match(business.verificationHistory.at(-1).note, /Automated check passed/);
    assert.equal(await Notification.countDocuments({ user: o.user.id, title: /Pending Verification/ }), 1);

    const list = await call("GET", "/api/verification", { cookie: o.cookie });
    assert.equal(list.json.checks[0].result.status, "Passed");
    assert.equal(list.json.verificationStatus, "Pending Verification");
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
    const res = await run(o, { type: "bvn", number: BVN, consent: true });
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
    const spaces = await run(o, { type: "bvn", number: "1234 5678 901", consent: true });
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

  it("limits attempts per type, and in total, per business per day", async () => {
    const o = await owner({ hasCac: "Yes", cacNumber: "RC1234567", hasTin: "Yes", tin: "12345678-0001" });
    answer = () => ({ status: 400, json: {} });
    for (let i = 0; i < 3; i++) assert.equal((await run(o, { type: "nin", number: `1000000000${i}`, consent: true })).status, 201);
    const fourth = await run(o, { type: "nin", number: "10000000009", consent: true });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.json.error.code, "check_limit");
    assert.equal(calls.length, 3, "a refused attempt never reaches the provider");

    // Another type has its own allowance of 3: 3 NIN + 3 BVN + 2 TIN = 8, the whole day's allowance.
    for (let i = 0; i < 3; i++) assert.equal((await run(o, { type: "bvn", number: `2000000000${i}`, consent: true })).status, 201);
    for (let i = 0; i < 2; i++) assert.equal((await run(o, { type: "tin" })).status, 201);
    // CAC has not been used, but the daily total is.
    const ninth = await run(o, { type: "cac" });
    assert.equal(ninth.status, 429);
    assert.equal(ninth.json.error.code, "check_limit");
    assert.equal(calls.length, 8);
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

  it("checks the TIN from the profile and compares the taxpayer name with the business or the owner", async () => {
    const o = await owner({ hasTin: "Yes", tin: "12345678-0001" });
    answer = () => hit({ taxpayer_name: "Ada Obi", cac_reg_number: "RC1", firstin: "F", jittin: "J", tax_office: "T", phone_number: "0801", email: "e@x.com" });
    const res = await run(o, { type: "tin" });
    assert.equal(res.json.check.status, "Passed");
    assert.deepEqual(calls[0].body, { number: "12345678-0001", channel: "TIN" });
    const stored = JSON.stringify(await VerificationCheck.find({ owner: o.user.id }).lean());
    assert.ok(!stored.includes("Ada Obi") && !stored.includes("e@x.com"));
    const blank = await owner();
    assert.equal((await run(blank, { type: "tin" })).status, 422);
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
    answer = () => ninRecord();
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

  it("an administrator can still decide: Pending Verification can be set to Verified by hand", async () => {
    const o = await owner();
    answer = () => ninRecord();
    await run(o, { type: "nin", number: NIN, consent: true });
    const set = await call("POST", `/api/admin/businesses/${o.business.id}/status`, { cookie: admin, body: { status: "Verified", note: "Documents and checks reviewed." } });
    assert.equal(set.status, 200);
    assert.equal(set.json.business.verificationStatus, "Verified");
    assert.ok(set.json.business.nmrepId);
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
