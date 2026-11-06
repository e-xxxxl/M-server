import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrembly, setPrembly } from "../src/lib/prembly.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The verification queue for NMREP staff.

let ctx;
let call;
let admin;
const quiet = { log() {}, error() {} };
const nin = { status: 200, json: { status: true, response_code: "00", data: { firstname: "Ada", surname: "Obi", telephoneno: "08011112222" }, verification: { reference: "r1" } } };

before(async () => {
  ctx = await startTestServer({ PREMBLY_API_KEY: "test-key-not-real", VERIFICATION_HASH_KEY: "h".repeat(40) });
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
  setPrembly(createPrembly({ apiKey: "k", baseUrl: "https://api.prembly.test" }, { fetchImpl: async () => new Response(JSON.stringify(nin.json), { status: 200 }), log: quiet }));
});
after(async () => {
  setPrembly(createPrembly(null));
  await ctx.stop();
});

describe("the verification queue", () => {
  it("lists businesses with their status, the NIN given and the checks, and counts by status", async () => {
    const reg = await call("POST", "/api/auth/register", { body: registrationBody({ business: { businessName: "Queue Traders" } }) });
    assert.equal(reg.status, 201, reg.text);
    const res = await call("GET", "/api/admin/verifications?status=all", { cookie: admin });
    assert.equal(res.status, 200, res.text);
    const row = res.json.items.find((i) => i.id === reg.json.business.id);
    assert.equal(row.businessName, "Queue Traders");
    assert.equal(row.ninGiven, true);
    assert.equal(row.ninMasked, "*******8901");
    assert.equal(row.nin.status, "Passed", "the NIN was checked at sign-up and the name matched");
    assert.equal(row.nin.nameMatch, true);
    assert.equal(row.nin.phoneMatch, false, "the record's phone is not the account's phone");
    assert.equal(row.cac, null);
    assert.equal(row.documentsShared, 0);
    assert.equal(typeof res.json.counts["Pending Verification"], "number");
    assert.equal(res.json.automatedChecksAvailable, true);
    assert.ok(!res.text.includes("12345678901"), "the NIN is never shown");
  });

  it("filters by status and name, and refuses unknown filters", async () => {
    const byName = await call("GET", "/api/admin/verifications?status=all&q=queue%20traders", { cookie: admin });
    assert.ok(byName.json.items.length >= 1 && byName.json.items.every((i) => /queue traders/i.test(i.businessName)));
    const verified = await call("GET", "/api/admin/verifications?status=Verified", { cookie: admin });
    assert.ok(verified.json.items.every((i) => i.verificationStatus === "Verified"));
    assert.equal((await call("GET", "/api/admin/verifications?status=Nope", { cookie: admin })).status, 422);
  });

  it("is for NMREP staff only", async () => {
    assert.equal((await call("GET", "/api/admin/verifications")).status, 401);
    const reg = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal((await call("GET", "/api/admin/verifications", { cookie: reg.cookie })).status, 403);
  });
});
