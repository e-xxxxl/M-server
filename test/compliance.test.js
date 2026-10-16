import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { client, registrationBody, startTestServer } from "./helpers.js";

let ctx;
let call;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
});
after(async () => {
  await ctx.stop();
});

async function signUp(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  return res;
}

describe("CAC and TIN are Yes or No questions", () => {
  it("No is stored as No, with no number, and completes the detail", async () => {
    const res = await signUp({ hasCac: "No", cacNumber: "RC999", hasTin: "No", tin: "123" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.business.hasCac, "No");
    assert.equal(res.json.business.cacNumber, "", "a number given with No is dropped");
    assert.equal(res.json.business.hasTin, "No");
    assert.equal(res.json.business.tin, "");

    const dash = await call("GET", "/api/dashboard", { cookie: res.cookie, origin: null });
    assert.equal(dash.json.insights.progress.total, 26, "the answers are not extra details");
    assert.equal(dash.json.insights.progress.completed, 17, "15 required plus CAC and TIN answered");
    const ids = dash.json.insights.nextActions.map((a) => a.id);
    assert.ok(!ids.includes("cac") && !ids.includes("tin"), "no CAC or TIN action once answered No");
  });

  it("Yes needs the number", async () => {
    const res = await signUp({ hasCac: "Yes", cacNumber: "" });
    assert.equal(res.status, 422);
    assert.ok(res.json.error.fields["business.cacNumber"]);
    const res2 = await signUp({ hasTin: "Yes", tin: "  " });
    assert.equal(res2.status, 422);
    assert.ok(res2.json.error.fields["business.tin"]);
  });

  it("Yes with a number is stored", async () => {
    const res = await signUp({ hasCac: "Yes", cacNumber: "RC1234567", hasTin: "Yes", tin: "12345678-0001" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.business.hasCac, "Yes");
    assert.equal(res.json.business.cacNumber, "RC1234567");
    assert.equal(res.json.business.hasTin, "Yes");
    assert.equal(res.json.business.tin, "12345678-0001");
  });

  it("a number sent without an answer counts as Yes, and an unanswered question stays blank", async () => {
    const withNumber = await signUp({ cacNumber: "RC1234567" });
    assert.equal(withNumber.json.business.hasCac, "Yes");
    const blank = await signUp();
    assert.equal(blank.json.business.hasCac, "");
    const dash = await call("GET", "/api/dashboard", { cookie: blank.cookie, origin: null });
    const ids = dash.json.insights.nextActions.map((a) => a.id);
    assert.ok(ids.includes("cac") && ids.includes("tin"), "still recommended while unanswered");
  });

  it("rejects an answer that is not Yes or No", async () => {
    const res = await signUp({ hasCac: "Maybe" });
    assert.equal(res.status, 422);
    assert.ok(res.json.error.fields["business.hasCac"]);
  });

  it("updates: No clears the number, Yes needs one, a number alone means Yes", async () => {
    const { cookie } = await signUp({ hasCac: "Yes", cacNumber: "RC1234567" });

    const no = await call("PATCH", "/api/business", { cookie, body: { hasCac: "No" } });
    assert.equal(no.status, 200, JSON.stringify(no.json));
    assert.equal(no.json.business.hasCac, "No");
    assert.equal(no.json.business.cacNumber, "");

    const yesWithout = await call("PATCH", "/api/business", { cookie, body: { hasCac: "Yes", cacNumber: "" } });
    assert.equal(yesWithout.status, 422);
    assert.ok(yesWithout.json.error.fields.cacNumber);

    const numberOnly = await call("PATCH", "/api/business", { cookie, body: { cacNumber: "RC7654321" } });
    assert.equal(numberOnly.status, 200);
    assert.equal(numberOnly.json.business.hasCac, "Yes");
    assert.equal(numberOnly.json.business.cacNumber, "RC7654321");

    const bad = await call("PATCH", "/api/business", { cookie, body: { hasTin: "Sometimes" } });
    assert.equal(bad.status, 422);
  });
});
