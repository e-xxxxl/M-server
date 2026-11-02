import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { applyRenames } from "../src/lib/renames.js";
import { Business } from "../src/models/Business.js";
import { Opportunity } from "../src/models/Opportunity.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// "Funding" is no longer a word in the product: the opportunity type, the partner type and one answer were renamed, and
// values stored under the old names are moved to the new ones when the server starts.

let ctx;
let call;
let admin;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

describe("the renamed values", () => {
  it("offers Opportunity instead of Funding, and the new answer, in the reference lists", async () => {
    const ref = await call("GET", "/api/reference", {});
    assert.deepEqual(ref.json.opportunityTypes, ["Opportunity", "Grant", "Loan", "Training", "Support"]);
    assert.equal(ref.json.fundingNeeds[0], "Not looking for an opportunity now");
    assert.ok(!JSON.stringify(ref.json).toLowerCase().replace(/fundingneeds/g, "").includes("funding"), "no list says funding any more");
    const groups = ref.json.opportunityTagGroups.map((g) => g.group);
    assert.ok(groups.includes("Business empowerment"));
    assert.ok(!groups.includes("Funding"));
  });

  it("creates an opportunity of the new type and refuses the old one", async () => {
    const ok = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "A new opportunity", provider: "Example", type: "Opportunity", description: "Text." } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.opportunity.type, "Opportunity");
    const old = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "An old one", provider: "Example", type: "Funding", description: "Text." } });
    assert.equal(old.status, 422);
  });

  it("moves values stored under the old names, and does it only once", async () => {
    const o = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal(o.status, 201, JSON.stringify(o.json));
    const made = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Stored as Funding", provider: "Example", type: "Grant", description: "Text." } });
    // Put old values straight into the database, the way a record from before the change would look.
    await Opportunity.collection.updateOne({ title: "Stored as Funding" }, { $set: { type: "Funding" } });
    await Business.collection.updateOne({ owner: (await Business.findById(o.json.business.id)).owner }, { $set: { fundingNeeds: "Not looking for funding now" } });

    const first = await applyRenames();
    assert.ok(first.opportunities >= 1);
    assert.ok(first.businesses >= 1);
    assert.equal((await Opportunity.findOne({ title: "Stored as Funding" })).type, "Opportunity");
    assert.equal((await Business.findById(o.json.business.id)).fundingNeeds, "Not looking for an opportunity now");
    assert.ok(made.status === 201);

    const second = await applyRenames();
    assert.deepEqual(second, { opportunities: 0, organisations: 0, businesses: 0 });
  });
});
