import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { compareFit, evaluate } from "../src/lib/eligibility.js";
import { toCsv } from "../src/lib/csv.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let admin; // cookie of an admin
let superAdmin;

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
  const s = await createStaff({ role: "super_admin" });
  superAdmin = (await logIn(call, s.email, s.password)).cookie;
});
after(async () => {
  await ctx.stop();
});

async function owner(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, businessId: res.json.business.id, userId: res.json.user.id };
}

const base = { title: "Agri growth grant", provider: "Example Foundation", type: "Grant", description: "Support for small farms." };

async function makeOpportunity(extra = {}, status) {
  const res = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { ...base, ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const id = res.json.opportunity.id;
  if (status) {
    const p = await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status } });
    assert.equal(p.status, 200, JSON.stringify(p.json));
  }
  return id;
}

describe("eligibility checks (pure)", () => {
  const business = {
    sector: "Manufacturing", state: "Lagos", businessType: "Private limited company", annualRevenue: "5 to 25 million naira",
    yearEstablished: new Date().getFullYear() - 3, employees: 10, hasCac: "Yes", hasTin: "No", verificationStatus: "Unverified",
  };
  const required = (key, rest) => ({ key, level: "required", ...rest });

  it("checks every kind of requirement", () => {
    const r = evaluate(
      [
        required("sector", { values: ["Manufacturing", "Retail and trading"] }),
        required("state", { values: ["Kano"] }),
        required("yearsInBusiness", { min: 2 }),
        required("employees", { min: 5, max: 20 }),
        required("hasCac", {}),
        { key: "hasTin", level: "preferred" },
        required("verified", {}),
      ],
      business,
    );
    const met = Object.fromEntries(r.checks.map((c) => [c.key, c.met]));
    assert.deepEqual(met, { sector: true, state: false, yearsInBusiness: true, employees: true, hasCac: true, hasTin: false, verified: false });
    assert.equal(r.met, 4);
    assert.equal(r.total, 7);
    assert.equal(r.requiredMissing, 2);
    assert.equal(r.label, "Nearly eligible");
  });

  it("labels: no requirements or all required met is Eligible, one or two missing is Nearly, more is Not", () => {
    assert.equal(evaluate([], business).label, "Eligible");
    assert.equal(evaluate([required("sector", { values: ["Manufacturing"] })], business).label, "Eligible");
    const miss = (n) => Array.from({ length: n }, (_, i) => required("state", { values: [`X${i}`] })).slice(0, 1).concat(
      [required("sector", { values: ["Other"] }), required("businessType", { values: ["Public limited company"] })].slice(0, Math.max(0, n - 1)),
    );
    assert.equal(evaluate(miss(1), business).label, "Nearly eligible");
    assert.equal(evaluate(miss(2), business).label, "Nearly eligible");
    assert.equal(evaluate(miss(3), business).label, "Not eligible");
  });

  it("a preferred requirement that is not met never blocks", () => {
    const r = evaluate([{ key: "state", level: "preferred", values: ["Kano"] }], business);
    assert.equal(r.label, "Eligible");
    assert.equal(r.met, 0);
  });

  it("an OR group is met when any one member is met, and counts as one requirement", () => {
    const either = [
      { key: "state", level: "required", values: ["Kano"], group: 1 },
      { key: "sector", level: "required", values: ["Manufacturing"], group: 1 },
    ];
    const r = evaluate([...either, required("hasCac", {})], business);
    assert.equal(r.total, 2, "the group counts once, plus the CAC rule");
    assert.equal(r.met, 2);
    assert.equal(r.label, "Eligible");
    assert.deepEqual(r.checks.map((c) => [c.key, c.group, c.met]), [["state", 1, false], ["sector", 1, true], ["hasCac", null, true]]);

    const none = evaluate([{ key: "state", level: "required", values: ["Kano"], group: 2 }, { key: "sector", level: "required", values: ["Other"], group: 2 }], business);
    assert.equal(none.requiredMissing, 1, "a group with no member met is one missing requirement");
    assert.equal(none.label, "Nearly eligible");

    const preferred = evaluate([{ key: "state", level: "preferred", values: ["Kano"], group: 1 }, { key: "sector", level: "preferred", values: ["Other"], group: 1 }], business);
    assert.equal(preferred.label, "Eligible", "a preferred group never blocks");
    assert.equal(preferred.met, 0);
  });

  it("missing values are not met and show as Not provided", () => {
    const r = evaluate([required("yearsInBusiness", { min: 1 })], { employees: 1 });
    assert.equal(r.checks[0].met, false);
    assert.equal(r.checks[0].yours, "Not provided");
  });

  it("orders eligible first, then more met, then nearest deadline", () => {
    const item = (label, met, deadline) => ({ fit: { label, met }, deadline });
    const list = [item("Not eligible", 5, null), item("Eligible", 1, "2027-02-01"), item("Eligible", 3, "2027-03-01"), item("Eligible", 3, "2027-01-01"), item("Nearly eligible", 4, null)];
    const sorted = [...list].sort(compareFit);
    assert.deepEqual(sorted.map((x) => `${x.fit.label}:${x.fit.met}:${x.deadline}`), [
      "Eligible:3:2027-01-01", "Eligible:3:2027-03-01", "Eligible:1:2027-02-01", "Nearly eligible:4:null", "Not eligible:5:null",
    ]);
  });
});

describe("csv", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    const csv = toCsv([{ header: "Name", value: (r) => r.name }], [{ name: '=HYPERLINK("x")' }, { name: "a, \"b\"" }, { name: "+1" }]);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
    assert.ok(csv.includes(`"a, ""b"""`));
    assert.ok(csv.includes(`"'+1"`));
  });
});

describe("opportunity access control and validation", () => {
  it("only admins can manage opportunities", async () => {
    const o = await owner();
    for (const [method, path] of [["GET", "/api/admin/opportunities"], ["POST", "/api/admin/opportunities"], ["GET", "/api/admin/applications"], ["GET", "/api/admin/reports"], ["GET", "/api/admin/export/businesses"]]) {
      assert.equal((await call(method, path, { body: method === "POST" ? base : undefined })).status, 401, `anon ${path}`);
      assert.equal((await call(method, path, { cookie: o.cookie, body: method === "POST" ? base : undefined })).status, 403, `owner ${path}`);
    }
    for (const path of ["/api/opportunities", "/api/applications", "/api/notifications"]) {
      assert.equal((await call("GET", path, { origin: null })).status, 401, `anon ${path}`);
      assert.equal((await call("GET", path, { cookie: admin, origin: null })).status, 403, `admin ${path}`);
    }
  });

  it("validates opportunities and their requirements", async () => {
    const bad = async (body) => call("POST", "/api/admin/opportunities", { cookie: admin, body });
    assert.equal((await bad({ ...base, title: "" })).status, 422);
    assert.equal((await bad({ ...base, type: "Gift" })).status, 422);
    assert.equal((await bad({ ...base, deadline: "31/12/2027" })).status, 422);
    assert.equal((await bad({ ...base, status: "Open" })).status, 422, "status cannot be set on create");
    const r1 = await bad({ ...base, criteria: [{ key: "sector", level: "required", values: ["Nonsense"] }] });
    assert.equal(r1.status, 422);
    assert.ok(r1.json.error.fields["criteria.0.values"]);
    assert.equal((await bad({ ...base, criteria: [{ key: "sector", level: "required" }] })).status, 422);
    assert.equal((await bad({ ...base, criteria: [{ key: "yearsInBusiness", level: "required" }] })).status, 422);
    assert.equal((await bad({ ...base, criteria: [{ key: "employees", level: "required", min: 10, max: 5 }] })).status, 422);
    assert.equal((await bad({ ...base, criteria: [{ key: "mystery", level: "required" }] })).status, 422);
    assert.equal((await bad({ ...base, criteria: [{ key: "hasCac", level: "must" }] })).status, 422);
    assert.equal(
      (await bad({ ...base, criteria: [{ key: "hasCac", level: "required" }, { key: "hasCac", level: "preferred" }] })).status,
      422,
      "the same requirement twice",
    );
    const ok = await bad({ ...base, deadline: "2027-06-30", criteria: [{ key: "hasCac", level: "required", values: ["ignored"] }] });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.opportunity.status, "Draft");
    assert.deepEqual(ok.json.opportunity.criteria, [{ key: "hasCac", level: "required" }], "irrelevant fields are dropped");
  });
});

describe("what owners see", () => {
  it("drafts are hidden, open ones are listed with a fit, closed ones disappear", async () => {
    const o = await owner({ sector: "Manufacturing", state: "Lagos" });
    const draft = await makeOpportunity({ title: "Hidden draft" });
    const open = await makeOpportunity({ title: "Visible open", criteria: [{ key: "sector", level: "required", values: ["Manufacturing"] }] }, "Open");
    const closed = await makeOpportunity({ title: "Was open" }, "Open");
    await call("PATCH", `/api/admin/opportunities/${closed}`, { cookie: admin, body: { status: "Closed" } });

    const list = await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null });
    assert.equal(list.status, 200);
    const titles = list.json.items.map((i) => i.title);
    assert.ok(titles.includes("Visible open"));
    assert.ok(!titles.includes("Hidden draft") && !titles.includes("Was open"));
    const item = list.json.items.find((i) => i.title === "Visible open");
    assert.deepEqual(item.fit, { label: "Eligible", met: 1, total: 1, requiredMissing: 0 });
    assert.equal(item.applicationStatus, null);

    assert.equal((await call("GET", `/api/opportunities/${draft}`, { cookie: o.cookie, origin: null })).status, 404);
    assert.equal((await call("GET", `/api/opportunities/${closed}`, { cookie: o.cookie, origin: null })).status, 404);
    assert.equal((await call("GET", "/api/opportunities/not-an-id", { cookie: o.cookie, origin: null })).status, 404);
    const detail = await call("GET", `/api/opportunities/${open}`, { cookie: o.cookie, origin: null });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.acceptingApplications, true);
    assert.equal(detail.json.fit.checks[0].yours, "Manufacturing");
    assert.equal(detail.json.opportunity.createdBy, undefined, "internal fields are not shown");
  });

  it("sorts eligible before not eligible and filters by type", async () => {
    const o = await owner({ sector: "Manufacturing" });
    await makeOpportunity({ title: "Zed not eligible", type: "Loan", criteria: [{ key: "sector", level: "required", values: ["Other"] }, { key: "verified", level: "required" }, { key: "hasTin", level: "required" }] }, "Open");
    await makeOpportunity({ title: "Aaa eligible", type: "Loan" }, "Open");
    const list = await call("GET", "/api/opportunities?type=Loan", { cookie: o.cookie, origin: null });
    const loans = list.json.items.filter((i) => ["Zed not eligible", "Aaa eligible"].includes(i.title));
    assert.deepEqual(loans.map((i) => `${i.title}:${i.fit.label}`), ["Aaa eligible:Eligible", "Zed not eligible:Not eligible"]);
    assert.ok(list.json.items.every((i) => i.type === "Loan"));
    assert.equal((await call("GET", "/api/opportunities?type=Gift", { cookie: o.cookie, origin: null })).status, 422);
  });

  it("the dashboard counts open opportunities the business is eligible for and has not applied to", async () => {
    const o = await owner({ sector: "Manufacturing" });
    const count = async () => (await call("GET", "/api/dashboard", { cookie: o.cookie, origin: null })).json.eligibleOpportunities;
    const before = await count();
    assert.equal(typeof before, "number");

    await makeOpportunity({ title: "Counted eligible" }, "Open");
    await makeOpportunity({ title: "Counted not eligible", criteria: [{ key: "sector", level: "required", values: ["Other"] }, { key: "verified", level: "required" }, { key: "hasTin", level: "required" }] }, "Open");
    await makeOpportunity({ title: "Counted draft" });
    assert.equal(await count(), before + 1, "only the open, eligible one counts");

    const eligible = (await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null })).json.items.find((i) => i.title === "Counted eligible");
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: eligible.id, message: "" } });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    assert.equal(await count(), before + 1, "a draft is still open to apply");

    const sent = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: eligible.id, message: "Please consider us.", submit: true, consent: { summary: true } } });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(await count(), before, "a submitted application no longer counts");
  });

  it("tags: up to five known categories, shown in the list and usable as a filter", async () => {
    const o = await owner();
    const tagged = await makeOpportunity({ title: "Tagged one", type: "Support", tags: ["Legal", "Insurance", "Legal"] }, "Open");
    await makeOpportunity({ title: "Untagged one", type: "Support" }, "Open");

    const stored = await call("GET", `/api/admin/opportunities/${tagged}`, { cookie: admin, origin: null });
    assert.deepEqual(stored.json.opportunity.tags, ["Legal", "Insurance"], "a repeated tag is kept once");
    assert.deepEqual((await call("GET", `/api/opportunities/${tagged}`, { cookie: o.cookie, origin: null })).json.opportunity.tags, ["Legal", "Insurance"]);

    const all = (await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null })).json.items;
    assert.deepEqual(all.find((i) => i.title === "Tagged one").tags, ["Legal", "Insurance"]);
    assert.deepEqual(all.find((i) => i.title === "Untagged one").tags, []);

    const legal = (await call("GET", "/api/opportunities?tag=Legal", { cookie: o.cookie, origin: null })).json.items;
    assert.ok(legal.length >= 1 && legal.every((i) => i.tags.includes("Legal")));
    assert.ok(!legal.some((i) => i.title === "Untagged one"));
    assert.equal((await call("GET", "/api/opportunities?tag=Gardening", { cookie: o.cookie, origin: null })).status, 422);

    const tooMany = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { ...base, tags: ["Equity", "Legal", "Export", "Insurance", "Logistics", "Technology"] } });
    assert.equal(tooMany.status, 422);
    const unknown = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { ...base, tags: ["Gardening"] } });
    assert.equal(unknown.status, 422);

    const edited = await call("PATCH", `/api/admin/opportunities/${tagged}`, { cookie: admin, body: { tags: [] } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.json.opportunity.tags, []);
  });

  it("an expired deadline hides the opportunity from the list and blocks applying", async () => {
    const o = await owner();
    const id = await makeOpportunity({ title: "Expired one" }, "Open");
    // Deadlines are whole days in the future by validation of the form, so move it into the past directly.
    const { Opportunity } = await import("../src/models/Opportunity.js");
    await Opportunity.updateOne({ _id: id }, { $set: { deadline: new Date(Date.now() - 86400000) } });
    const list = await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null });
    assert.ok(!list.json.items.some((i) => i.title === "Expired one"));
    const res = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "" } });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "closed");
  });
});

describe("applications", () => {
  it("needs every required requirement, then saves a draft and submits with a snapshot", async () => {
    const o = await owner({ sector: "Manufacturing", state: "Lagos" });
    const id = await makeOpportunity({ criteria: [{ key: "state", level: "required", values: ["Kano"] }] }, "Open");
    const refused = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id } });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.error.code, "not_eligible");

    const okId = await makeOpportunity({ criteria: [{ key: "state", level: "required", values: ["Lagos"] }, { key: "hasTin", level: "preferred" }] }, "Open");
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: okId, message: "First thoughts" } });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    assert.equal(draft.json.application.status, "Draft");
    assert.equal(draft.json.application.snapshot, null);

    const submit = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: okId, message: "We farm and need a mill.", submit: true, consent: { summary: true } } });
    assert.equal(submit.status, 201);
    assert.equal(submit.json.application.status, "Submitted");
    assert.equal(submit.json.application.id, draft.json.application.id, "the draft became the application");
    assert.equal(submit.json.application.snapshot.state, "Lagos");
    assert.equal(submit.json.application.snapshot.referral, undefined, "referral data is never copied");
    assert.deepEqual(submit.json.application.history.map((h) => h.status), ["Draft", "Submitted"]);

    // Editing the profile afterwards does not change what was submitted.
    await call("PATCH", "/api/business", { cookie: o.cookie, body: { state: "Kano" } });
    const again = await call("GET", `/api/applications/${submit.json.application.id}`, { cookie: o.cookie, origin: null });
    assert.equal(again.json.application.snapshot.state, "Lagos");

    // Submitted applications cannot be edited or created twice.
    const edit = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: okId, message: "changed" } });
    assert.equal(edit.status, 409);
    assert.equal(edit.json.error.code, "already_submitted");
  });

  it("validates the message length and the shape of the request", async () => {
    const o = await owner();
    const id = await makeOpportunity({}, "Open");
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "x".repeat(501) } })).status, 422);
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: "nope" } })).status, 422);
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, status: "Approved" } })).status, 422, "no status from the owner");
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: "a".repeat(24) } })).status, 404);
  });

  it("withdraw, then reopen as a draft or submit again", async () => {
    const o = await owner();
    const id = await makeOpportunity({}, "Open");
    const sub = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: true } } });
    const appId = sub.json.application.id;
    const w = await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie });
    assert.equal(w.status, 200);
    assert.equal(w.json.application.status, "Withdrawn");
    assert.equal((await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie })).status, 409, "already withdrawn");
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "again" } });
    assert.equal(draft.json.application.status, "Draft");
    const resub = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: true } } });
    assert.equal(resub.json.application.status, "Submitted");
    assert.equal(resub.json.application.id, appId, "still one application per opportunity");
    const list = await call("GET", "/api/applications", { cookie: o.cookie, origin: null });
    assert.equal(list.json.items.filter((a) => a.opportunityId === id).length, 1);
  });

  it("another owner cannot see or withdraw it", async () => {
    const a = await owner();
    const b = await owner();
    const id = await makeOpportunity({}, "Open");
    const sub = await call("POST", "/api/applications", { cookie: a.cookie, body: { opportunityId: id, submit: true, consent: { summary: true } } });
    const appId = sub.json.application.id;
    assert.equal((await call("GET", `/api/applications/${appId}`, { cookie: b.cookie, origin: null })).status, 404);
    assert.equal((await call("POST", `/api/applications/${appId}/withdraw`, { cookie: b.cookie })).status, 404);
    assert.equal((await call("GET", "/api/applications", { cookie: b.cookie, origin: null })).json.items.length, 0);
  });

  it("one application per opportunity even with two requests at once", async () => {
    const o = await owner();
    const id = await makeOpportunity({}, "Open");
    const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: true } } })));
    assert.ok(results.every((r) => [201, 409].includes(r.status)), results.map((r) => r.status).join(","));
    const list = await call("GET", "/api/applications", { cookie: o.cookie, origin: null });
    assert.equal(list.json.items.filter((a) => a.opportunityId === id).length, 1);
  });
});

describe("admin review", () => {
  async function submitted() {
    const o = await owner({ sector: "Manufacturing" });
    const id = await makeOpportunity({ title: "Review me", criteria: [{ key: "sector", level: "required", values: ["Manufacturing"] }, { key: "hasTin", level: "preferred" }] }, "Open");
    const sub = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "Hello reviewer", submit: true, consent: { summary: true } } });
    return { o, id, appId: sub.json.application.id };
  }

  it("lists, filters and shows the snapshot with how it compared", async () => {
    const { appId, id } = await submitted();
    const list = await call("GET", `/api/admin/applications?opportunity=${id}&status=Submitted`, { cookie: admin, origin: null });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].opportunityTitle, "Review me");
    const detail = await call("GET", `/api/admin/applications/${appId}`, { cookie: admin, origin: null });
    assert.equal(detail.json.application.message, "Hello reviewer");
    assert.equal(detail.json.application.snapshot.sector, "Manufacturing");
    assert.equal(detail.json.fit.label, "Eligible");
    assert.equal(detail.json.fit.met, 1);
    assert.deepEqual(detail.json.allowed, ["Screening", "Under Review", "More Information Required", "Approved", "Declined", "Waitlisted"]);
    assert.ok(detail.json.owner.email);
    assert.equal((await call("GET", "/api/admin/applications?status=Maybe", { cookie: admin, origin: null })).status, 422);
  });

  it("drafts are not visible to admins", async () => {
    const o = await owner();
    const id = await makeOpportunity({ title: "Draft only" }, "Open");
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id } });
    const list = await call("GET", `/api/admin/applications?opportunity=${id}`, { cookie: admin, origin: null });
    assert.equal(list.json.total, 0);
    assert.equal((await call("GET", `/api/admin/applications/${draft.json.application.id}`, { cookie: admin, origin: null })).status, 404);
  });

  it("moves through the allowed statuses with a note, notifies the owner, and final means final", async () => {
    const { o, appId } = await submitted();
    const post = (body) => call("POST", `/api/admin/applications/${appId}/status`, { cookie: admin, body });
    assert.equal((await post({ status: "Under Review" })).status, 422, "a note is required");
    assert.equal((await post({ status: "Withdrawn", note: "x" })).status, 422, "admins cannot withdraw");
    assert.equal((await post({ status: "Submitted", note: "x" })).status, 422, "no going back");
    const review = await post({ status: "Under Review", note: "We are looking at it" });
    assert.equal(review.status, 200, JSON.stringify(review.json));
    const approved = await post({ status: "Approved", note: "Congratulations" });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.json.application.history.map((h) => h.status), ["Draft", "Submitted", "Under Review", "Approved"]);
    assert.equal((await post({ status: "Declined", note: "changed my mind" })).status, 422, "final");

    const mine = await call("GET", "/api/applications", { cookie: o.cookie, origin: null });
    assert.equal(mine.json.items[0].status, "Approved");
    const notes = await call("GET", "/api/notifications", { cookie: o.cookie, origin: null });
    assert.ok(notes.json.items.some((n) => n.type === "application" && /approved/i.test(n.title) && n.body === "Congratulations"));
    assert.equal((await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie })).status, 409, "an approved application cannot be withdrawn");
  });

  it("the audit log records the action", async () => {
    const { appId } = await submitted();
    await call("POST", `/api/admin/applications/${appId}/status`, { cookie: admin, body: { status: "Declined", note: "Not a fit" } });
    const log = await call("GET", "/api/admin/audit", { cookie: superAdmin, origin: null });
    assert.ok(log.json.items.some((e) => e.action === "application.status" && /Declined/.test(e.summary)));
    assert.ok(log.json.items.some((e) => e.action === "opportunity.create"));
  });
});

describe("opening an opportunity tells owners who qualify", () => {
  it("notifies eligible owners once, not owners who do not qualify, and not again on reopening", async () => {
    const yes = await owner({ sector: "Manufacturing" });
    const no = await owner({ sector: "Other" });
    const id = await makeOpportunity({ title: "Announced one", criteria: [{ key: "sector", level: "required", values: ["Manufacturing"] }] });
    const before = await call("GET", "/api/notifications", { cookie: yes.cookie, origin: null });
    assert.ok(!before.json.items.some((n) => /Announced one/.test(n.title)), "nothing while it is a draft");

    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Open" } });
    const a = await call("GET", "/api/notifications", { cookie: yes.cookie, origin: null });
    const mine = a.json.items.filter((n) => /Announced one/.test(n.title));
    assert.equal(mine.length, 1);
    assert.match(mine[0].link, /^\/dashboard\/opportunities\/detail\/\?id=[a-f0-9]{24}$/);
    const b = await call("GET", "/api/notifications", { cookie: no.cookie, origin: null });
    assert.ok(!b.json.items.some((n) => /Announced one/.test(n.title)));

    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Closed" } });
    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Open" } });
    const c = await call("GET", "/api/notifications", { cookie: yes.cookie, origin: null });
    assert.equal(c.json.items.filter((n) => /Announced one/.test(n.title)).length, 1, "no repeat on reopening");
  });
});

describe("notifications", () => {
  it("counts unread, marks some or all as read, and only touches your own", async () => {
    const a = await owner();
    const b = await owner();
    // Two status changes from an admin create two notifications for owner a.
    for (const [status, note] of [["Pending Verification", "Checking"], ["Verified", "All good"]]) {
      const r = await call("POST", `/api/admin/businesses/${a.businessId}/status`, { cookie: admin, body: { status, note } });
      assert.equal(r.status, 200);
    }
    const dash = await call("GET", "/api/dashboard", { cookie: a.cookie, origin: null });
    assert.equal(dash.json.unreadNotifications, 2);
    const list = await call("GET", "/api/notifications", { cookie: a.cookie, origin: null });
    assert.equal(list.json.unread, 2);
    assert.equal(list.json.items[0].user, undefined, "the owner id is not exposed");
    assert.ok(list.json.items.some((n) => n.type === "verification" && /Verified/.test(n.title)));

    const one = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: [list.json.items[0].id] } });
    assert.equal(one.json.unread, 1);
    // Marking someone else's notification does nothing.
    const bList = await call("GET", "/api/notifications", { cookie: b.cookie, origin: null });
    assert.equal(bList.json.items.length, 0);
    const cross = await call("POST", "/api/notifications/read", { cookie: b.cookie, body: { ids: [list.json.items[1].id] } });
    assert.equal(cross.json.unread, 0);
    const still = await call("GET", "/api/notifications", { cookie: a.cookie, origin: null });
    assert.equal(still.json.unread, 1);

    const all = await call("POST", "/api/notifications/read", { cookie: a.cookie, body: {} });
    assert.equal(all.json.unread, 0);
    assert.equal((await call("POST", "/api/notifications/read", { cookie: a.cookie, body: { ids: ["nope"] } })).status, 422);
  });
});

describe("reports and exports", () => {
  it("summarises registrations and applications", async () => {
    await owner({ state: "Kano", sector: "Manufacturing" });
    const res = await call("GET", "/api/admin/reports", { cookie: admin, origin: null });
    assert.equal(res.status, 200);
    assert.ok(res.json.totalBusinesses >= 1);
    assert.ok(res.json.byState.find((r) => r.name === "Kano").count >= 1);
    assert.ok(res.json.bySector.find((r) => r.name === "Manufacturing"));
    assert.ok(Array.isArray(res.json.byMonth) && res.json.byMonth.length >= 1);
    assert.ok(Array.isArray(res.json.applicationsPerOpportunity));
    assert.ok(res.json.applicationsByStatus.length >= 1);
  });

  it("breaks the registry down by place, type, revenue, size and age, counting every business once", async () => {
    await owner({ state: "Oyo", lga: "Ibadan North", employees: 12, yearEstablished: new Date().getFullYear() - 4, annualRevenue: "5 to 25 million naira" });
    const r = (await call("GET", "/api/admin/reports", { cookie: admin, origin: null })).json;
    const sum = (rows) => rows.reduce((n, x) => n + x.count, 0);
    assert.ok(r.byLga.find((x) => x.name === "Ibadan North, Oyo").count >= 1);
    for (const key of ["byBusinessType", "byAnnualRevenue", "byEmployees", "byBusinessAge"]) assert.equal(sum(r[key]), r.totalBusinesses, key);
    assert.deepEqual(r.byEmployees.map((x) => x.name), ["0 to 9 employees", "10 to 49 employees", "50 to 199 employees", "200 or more employees"]);
    assert.ok(r.byEmployees[1].count >= 1);
    assert.ok(r.byBusinessAge.find((x) => x.name === "3 to 5 years").count >= 1);
    assert.equal(r.byAnnualRevenue.length >= 5, true, "every choice on the form is listed, even with no businesses");
    assert.ok(r.totalEmployees >= 12);
    assert.deepEqual(Object.keys(r.training).sort(), ["certificatesIssued", "completed", "failed", "participants", "passed"]);
    assert.ok(!JSON.stringify(r).includes("@"), "no contact details appear in the counts");
  });

  it("exports CSV files that cannot run formulas, and logs the export", async () => {
    await owner({ businessName: "=cmd|calc" });
    const res = await call("GET", "/api/admin/export/businesses", { cookie: admin, origin: null });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("content-disposition"), /attachment/);
    assert.ok(res.text.includes(`"'=cmd|calc"`));
    assert.ok(!res.text.includes(`,"=cmd`), "never a raw formula cell");
    assert.ok(res.text.replace(/^﻿/, "").startsWith('"NMREP ID"'));
    const apps = await call("GET", "/api/admin/export/applications", { cookie: admin, origin: null });
    assert.equal(apps.status, 200);
    assert.ok(apps.text.includes('"Opportunity"'));
    const log = await call("GET", "/api/admin/audit", { cookie: superAdmin, origin: null });
    assert.ok(log.json.items.some((e) => e.action === "export.businesses"));
  });
});

describe("opportunity editing", () => {
  it("edits fields and requirements, and lists counts", async () => {
    const id = await makeOpportunity({ title: "Editable" });
    const res = await call("PATCH", `/api/admin/opportunities/${id}`, {
      cookie: admin,
      body: { title: "Edited title", deadline: "2030-01-31", criteria: [{ key: "employees", level: "required", min: 1 }] },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.opportunity.title, "Edited title");
    assert.equal(res.json.opportunity.criteria[0].min, 1);
    assert.equal((await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: {} })).status, 422);
    assert.equal((await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { createdBy: "x" } })).status, 422);
    assert.equal((await call("PATCH", `/api/admin/opportunities/${"b".repeat(24)}`, { cookie: admin, body: { title: "x" } })).status, 404);
    const detail = await call("GET", `/api/admin/opportunities/${id}`, { cookie: admin, origin: null });
    assert.equal(detail.json.applications.Submitted, 0);
    const list = await call("GET", "/api/admin/opportunities", { cookie: admin, origin: null });
    assert.ok(list.json.items.some((o) => o.id === id && o.applications === 0));
  });
});

describe("indexes", () => {
  it("one application per business per opportunity is enforced by the database", async () => {
    const { Application } = await import("../src/models/Application.js");
    await Application.init();
    const indexes = await Application.collection.indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.opportunity === 1 && i.key.business === 1));
  });
});
