import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let admin;
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

let counter = 0;

async function owner(business = {}, account = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business, account }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, businessId: res.json.business.id, email: res.json.user.email, phone: res.json.user.phone };
}

/** An organisation with one partner login that has already replaced its temporary password. */
async function partner(type = "Bank") {
  counter += 1;
  const name = `Partner ${counter} ${Date.now()}`;
  const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name, type, description: "Test organisation" } });
  assert.equal(org.status, 201, JSON.stringify(org.json));
  const orgId = org.json.organisation.id;
  const email = `partner${counter}-${Date.now()}@example.com`;
  const created = await call("POST", `/api/admin/organisations/${orgId}/users`, { cookie: admin, body: { fullName: "Pat Partner", email, phone: "08011112222" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const login = await logIn(call, email, created.json.temporaryPassword);
  assert.equal(login.status, 200);
  const changed = await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "PartnerPass1" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  return { name, orgId, email, cookie: login.cookie, userId: created.json.user.id, password: "PartnerPass1" };
}

const base = { title: "Partner programme", type: "Grant", description: "A programme run by a partner." };

/** A partner creates, submits and an admin approves an opportunity. Returns its id. */
async function openByPartner(p, extra = {}) {
  const c = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: { ...base, ...extra } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const id = c.json.opportunity.id;
  assert.equal((await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie })).status, 200);
  const a = await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return id;
}

const apply = (o, opportunityId, extra = {}) =>
  call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId, message: "Please consider us.", submit: true, consent: { summary: true }, ...extra } });

describe("organisations and partner logins", () => {
  it("only admins manage organisations", async () => {
    const o = await owner();
    const p = await partner();
    for (const [method, path] of [["GET", "/api/admin/organisations"], ["POST", "/api/admin/organisations"], ["GET", "/api/admin/organisation-types"]]) {
      assert.equal((await call(method, path, { body: method === "POST" ? { name: "X", type: "Bank" } : undefined })).status, 401, `anon ${path}`);
      assert.equal((await call(method, path, { cookie: o.cookie, body: method === "POST" ? { name: "X", type: "Bank" } : undefined })).status, 403, `owner ${path}`);
      assert.equal((await call(method, path, { cookie: p.cookie, body: method === "POST" ? { name: "X", type: "Bank" } : undefined })).status, 403, `partner ${path}`);
    }
    assert.equal((await call("GET", "/api/admin/organisations", { cookie: admin, origin: null })).status, 200);
    assert.equal((await call("GET", "/api/admin/organisations", { cookie: superAdmin, origin: null })).status, 200);
  });

  it("validates types, offers the government ones, offers training providers, keeps funding partners for later, and refuses duplicate names", async () => {
    const make = (body) => call("POST", "/api/admin/organisations", { cookie: admin, body });
    const stamp = Date.now();
    const ministry = await make({ name: `Ministry ${stamp}`, type: "Government Ministry" });
    assert.equal(ministry.status, 201);
    assert.equal((await make({ name: `Agency ${stamp}`, type: "Government Agency" })).status, 201);
    assert.equal((await make({ name: `Bad ${stamp}`, type: "Spaceship" })).status, 422);
    assert.equal((await make({ name: `Train ${stamp}`, type: "Training Provider" })).status, 201);
    assert.equal((await make({ name: `Fund ${stamp}`, type: "Funding Partner" })).status, 422);
    assert.equal((await make({ name: "", type: "Bank" })).status, 422);
    assert.equal((await make({ name: `Extra ${stamp}`, type: "Bank", active: false })).status, 422, "no unknown fields");
    const dup = await make({ name: `ministry ${stamp}`, type: "Bank" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "name_taken");
    const types = await call("GET", "/api/admin/organisation-types", { cookie: admin, origin: null });
    assert.ok(types.json.available.includes("Government Ministry") && types.json.available.includes("Bank"));
    assert.ok(types.json.available.includes("Training Provider"));
    assert.deepEqual(types.json.later, ["Funding Partner"]);
  });

  it("a new partner login must replace its temporary password before anything else", async () => {
    const org = await call("POST", "/api/admin/organisations", { cookie: admin, body: { name: `Temp ${Date.now()}`, type: "Bank" } });
    const created = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, {
      cookie: admin,
      body: { fullName: "New Person", email: `new-${Date.now()}@example.com`, phone: "08012345678" },
    });
    assert.equal(created.status, 201);
    assert.match(created.json.temporaryPassword, /^[A-Za-z0-9-]{10,}$/);
    assert.equal(created.json.user.role, "partner");
    assert.equal(created.json.user.mustChangePassword, true);
    assert.equal(created.json.user.passwordHash, undefined);
    const login = await logIn(call, created.json.user.email, created.json.temporaryPassword);
    assert.equal(login.status, 200);
    assert.equal(login.json.business, null);
    const blocked = await call("GET", "/api/partner/overview", { cookie: login.cookie, origin: null });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "password_change_required");
    const me = await call("GET", "/api/partner/me", { cookie: login.cookie, origin: null });
    assert.equal(me.status, 200, "the portal can still load who they are");
    assert.equal(me.json.organisation.name, org.json.organisation.name);
    await call("POST", "/api/account/password", { cookie: login.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "BrandNewPass1" } });
    assert.equal((await call("GET", "/api/partner/overview", { cookie: login.cookie, origin: null })).status, 200);
    const dupEmail = await call("POST", `/api/admin/organisations/${org.json.organisation.id}/users`, {
      cookie: admin,
      body: { fullName: "Again", email: created.json.user.email, phone: "08012345678" },
    });
    assert.equal(dupEmail.status, 409);
  });

  it("switching an organisation off signs its people out and blocks login; switching it on restores it", async () => {
    const p = await partner();
    assert.equal((await call("GET", "/api/partner/overview", { cookie: p.cookie, origin: null })).status, 200);
    const off = await call("PATCH", `/api/admin/organisations/${p.orgId}`, { cookie: admin, body: { active: false } });
    assert.equal(off.status, 200);
    assert.equal((await call("GET", "/api/partner/overview", { cookie: p.cookie, origin: null })).status, 401);
    const blocked = await logIn(call, p.email, p.password);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.json.error.code, "invalid_credentials", "the same answer as a wrong password");
    await call("PATCH", `/api/admin/organisations/${p.orgId}`, { cookie: admin, body: { active: true } });
    assert.equal((await logIn(call, p.email, p.password)).status, 200);
  });

  it("a partner login can be deactivated and its password reset", async () => {
    const p = await partner();
    const off = await call("PATCH", `/api/admin/partner-users/${p.userId}`, { cookie: admin, body: { active: false } });
    assert.equal(off.status, 200);
    assert.equal((await call("GET", "/api/partner/overview", { cookie: p.cookie, origin: null })).status, 401);
    assert.equal((await logIn(call, p.email, p.password)).status, 401);
    await call("PATCH", `/api/admin/partner-users/${p.userId}`, { cookie: admin, body: { active: true } });
    const reset = await call("POST", `/api/admin/partner-users/${p.userId}/reset-password`, { cookie: admin });
    assert.equal(reset.status, 200);
    assert.equal((await logIn(call, p.email, p.password)).status, 401, "the old password no longer works");
    const again = await logIn(call, p.email, reset.json.temporaryPassword);
    assert.equal(again.status, 200);
    assert.equal(again.json.user.mustChangePassword, true);
    assert.equal((await call("PATCH", `/api/admin/partner-users/${"a".repeat(24)}`, { cookie: admin, body: { active: false } })).status, 404);
    // Staff and owners are not partner logins.
    const o = await owner();
    assert.equal((await call("PATCH", `/api/admin/partner-users/${o.businessId}`, { cookie: admin, body: { active: false } })).status, 404);
  });

  it("each role only reaches its own endpoints", async () => {
    const p = await partner();
    const o = await owner();
    for (const path of ["/api/admin/overview", "/api/admin/businesses", "/api/admin/opportunities", "/api/admin/agents", "/api/admin/audit"]) {
      assert.equal((await call("GET", path, { cookie: p.cookie, origin: null })).status, 403, `partner ${path}`);
    }
    for (const path of ["/api/dashboard", "/api/business", "/api/opportunities", "/api/applications", "/api/notifications", "/api/consents"]) {
      assert.equal((await call("GET", path, { cookie: p.cookie, origin: null })).status, 403, `partner ${path}`);
    }
    for (const path of ["/api/partner/overview", "/api/partner/opportunities", "/api/partner/applications"]) {
      assert.equal((await call("GET", path, { cookie: o.cookie, origin: null })).status, 403, `owner ${path}`);
      assert.equal((await call("GET", path, { cookie: admin, origin: null })).status, 403, `admin ${path}`);
      assert.equal((await call("GET", path, { origin: null })).status, 401, `anon ${path}`);
    }
  });
});

describe("partner opportunities and approval", () => {
  it("a partner's opportunity is a draft in its own name, and cannot choose status or provider", async () => {
    const p = await partner("Government Agency");
    const bad = (body) => call("POST", "/api/partner/opportunities", { cookie: p.cookie, body });
    assert.equal((await bad({ ...base, provider: "Someone else" })).status, 422);
    assert.equal((await bad({ ...base, status: "Open" })).status, 422);
    assert.equal((await bad({ ...base, organisation: p.orgId })).status, 422);
    assert.equal((await bad({ ...base, title: "" })).status, 422);
    assert.equal((await bad({ ...base, beneficiaryLimit: "0" })).status, 422);
    const ok = await bad({ ...base, opensOn: "2030-01-10", deadline: "2030-06-30", beneficiaryLimit: "25", criteria: [{ key: "state", level: "required", values: ["Kano"] }] });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const o = ok.json.opportunity;
    assert.equal(o.status, "Draft");
    assert.equal(o.provider, p.name);
    assert.equal(o.organisation, p.orgId);
    assert.equal(o.beneficiaryLimit, 25);
    assert.equal(o.createdBy, undefined);
  });

  it("goes draft, pending approval, back with a note, pending again, then open; owners only see it once open", async () => {
    const p = await partner();
    const eligible = await owner();
    const create = await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: base });
    const id = create.json.opportunity.id;

    const edit = await call("PATCH", `/api/partner/opportunities/${id}`, { cookie: p.cookie, body: { title: "Edited by partner" } });
    assert.equal(edit.status, 200);
    assert.equal((await call("PATCH", `/api/partner/opportunities/${id}`, { cookie: p.cookie, body: {} })).status, 422);
    assert.equal((await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin })).status, 409, "a draft cannot be approved");

    const sub = await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
    assert.equal(sub.json.opportunity.status, "Pending Approval");
    const locked = await call("PATCH", `/api/partner/opportunities/${id}`, { cookie: p.cookie, body: { title: "Too late" } });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error.code, "locked");
    assert.equal((await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie })).status, 409);

    // Hidden from owners while waiting.
    const list = await call("GET", "/api/opportunities", { cookie: eligible.cookie, origin: null });
    assert.ok(!list.json.items.some((i) => i.id === id));
    assert.equal((await call("GET", `/api/opportunities/${id}`, { cookie: eligible.cookie, origin: null })).status, 404);
    assert.equal((await apply(eligible, id)).status, 404);

    // The admin sees the queue.
    const queue = await call("GET", "/api/admin/opportunities?status=Pending%20Approval", { cookie: admin, origin: null });
    const row = queue.json.items.find((i) => i.id === id);
    assert.equal(row.organisationName, p.name);
    assert.ok(queue.json.pendingApproval >= 1);
    assert.equal((await call("GET", "/api/admin/opportunities?status=Nonsense", { cookie: admin, origin: null })).status, 422);

    // Sent back with a reason, edited, submitted again, approved.
    assert.equal((await call("POST", `/api/admin/opportunities/${id}/return`, { cookie: admin, body: {} })).status, 422, "a reason is needed");
    const back = await call("POST", `/api/admin/opportunities/${id}/return`, { cookie: admin, body: { note: "Add the deadline." } });
    assert.equal(back.json.opportunity.status, "Draft");
    const seen = await call("GET", `/api/partner/opportunities/${id}`, { cookie: p.cookie, origin: null });
    assert.equal(seen.json.opportunity.reviewNote, "Add the deadline.");
    assert.equal((await call("PATCH", `/api/partner/opportunities/${id}`, { cookie: p.cookie, body: { deadline: "2031-01-31" } })).status, 200);
    await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie });
    const approved = await call("POST", `/api/admin/opportunities/${id}/approve`, { cookie: admin });
    assert.equal(approved.json.opportunity.status, "Open");
    assert.equal(approved.json.opportunity.reviewNote, "");
    const now = await call("GET", "/api/opportunities", { cookie: eligible.cookie, origin: null });
    const item = now.json.items.find((i) => i.id === id);
    assert.equal(item.organisationName, p.name);
    const notes = await call("GET", "/api/notifications", { cookie: eligible.cookie, origin: null });
    assert.ok(notes.json.items.some((n) => /Edited by partner/.test(n.title)), "qualifying owners are told");

    // The partner can close its own open opportunity but not reopen it.
    const closed = await call("POST", `/api/partner/opportunities/${id}/close`, { cookie: p.cookie });
    assert.equal(closed.json.opportunity.status, "Closed");
    assert.equal((await call("POST", `/api/partner/opportunities/${id}/close`, { cookie: p.cookie })).status, 409);
    assert.equal((await call("POST", `/api/partner/opportunities/${id}/submit`, { cookie: p.cookie })).status, 409);
  });

  it("an organisation sees only its own opportunities and applicants", async () => {
    const a = await partner();
    const b = await partner();
    const idA = await openByPartner(a, { title: "A only" });
    await openByPartner(b, { title: "B only" });
    const platform = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Platform run", provider: "NMREP", type: "Support", description: "Run by NMREP." } });
    const platformId = platform.json.opportunity.id;
    await call("PATCH", `/api/admin/opportunities/${platformId}`, { cookie: admin, body: { status: "Open" } });

    const o = await owner();
    const appA = (await apply(o, idA)).json.application.id;
    const appPlatform = (await apply(o, platformId)).json.application.id;

    const listB = await call("GET", "/api/partner/opportunities", { cookie: b.cookie, origin: null });
    assert.deepEqual(listB.json.items.map((i) => i.title), ["B only"]);
    for (const [method, path, body] of [
      ["GET", `/api/partner/opportunities/${idA}`],
      ["PATCH", `/api/partner/opportunities/${idA}`, { title: "Hijack" }],
      ["POST", `/api/partner/opportunities/${idA}/submit`],
      ["POST", `/api/partner/opportunities/${idA}/close`],
      ["GET", `/api/partner/opportunities/${platformId}`],
      ["GET", `/api/partner/applications/${appA}`],
      ["POST", `/api/partner/applications/${appA}/status`, { status: "Approved", note: "no" }],
      ["GET", `/api/partner/applications/${appPlatform}`],
      ["GET", `/api/partner/applications?opportunity=${idA}`],
    ]) {
      const res = await call(method, path, { cookie: b.cookie, body, origin: method === "GET" ? null : undefined });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const appsB = await call("GET", "/api/partner/applications", { cookie: b.cookie, origin: null });
    assert.equal(appsB.json.total, 0);
    const appsA = await call("GET", "/api/partner/applications", { cookie: a.cookie, origin: null });
    assert.equal(appsA.json.total, 1);
    assert.equal((await call("GET", `/api/partner/applications/${appA}`, { cookie: a.cookie, origin: null })).status, 200);
    const mine = await call("GET", `/api/partner/opportunities/${idA}`, { cookie: a.cookie, origin: null });
    assert.equal(mine.json.opportunity.title, "A only");
    // B's data is untouched.
    assert.equal((await call("GET", `/api/partner/opportunities/${idA}`, { cookie: admin, origin: null })).status, 403);
  });

  it("an opening date hides the opportunity until it arrives", async () => {
    const p = await partner();
    const o = await owner();
    const id = await openByPartner(p, { title: "Opens later", opensOn: "2099-01-01" });
    const list = await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null });
    assert.ok(!list.json.items.some((i) => i.id === id));
    const res = await apply(o, id);
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "closed");
    const detail = await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null });
    assert.equal(detail.json.acceptingApplications, false);
  });

  it("switching an organisation off hides its opportunities from owners", async () => {
    const p = await partner();
    const o = await owner();
    const id = await openByPartner(p, { title: "Will vanish" });
    assert.ok((await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null })).json.items.some((i) => i.id === id));
    const sub = await apply(o, id);
    assert.equal(sub.status, 201);
    await call("PATCH", `/api/admin/organisations/${p.orgId}`, { cookie: admin, body: { active: false } });
    assert.ok(!(await call("GET", "/api/opportunities", { cookie: o.cookie, origin: null })).json.items.some((i) => i.id === id));
    const other = await owner();
    assert.equal((await call("GET", `/api/opportunities/${id}`, { cookie: other.cookie, origin: null })).status, 404);
    assert.equal((await apply(other, id)).status, 422);
    // Someone who already applied can still see theirs.
    const mine = await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.acceptingApplications, false);
  });
});

describe("consent and what a partner can see", () => {
  const secrets = (o) => [o.email, o.phone, "12 Allen Avenue", "RC7654321", "12345678-0001", "Secret Bank", "obifabrics.com", "obi_fabrics"];

  it("applying needs agreement to share the business summary, and the owner is told what is shared", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner();
    const detail = await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null });
    assert.equal(detail.json.sharing.with, p.name);
    assert.deepEqual(detail.json.sharing.categories.map((c) => c.key), ["summary", "contact", "profile", "documents"]);
    assert.equal(detail.json.sharing.categories[0].required, true);
    assert.match(detail.json.sharing.neverShared, /NIN, BVN/);

    const none = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true } });
    assert.equal(none.status, 422);
    assert.equal(none.json.error.code, "consent_required");
    assert.ok(none.json.error.fields["consent.summary"]);
    const declined = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: false, contact: true } } });
    assert.equal(declined.status, 422);
    assert.equal((await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: true, banking: true } } })).status, 422, "no unknown categories");
    // A draft needs no agreement yet.
    const draft = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "draft" } });
    assert.equal(draft.status, 201);
    assert.equal(draft.json.application.status, "Draft");
    // The partner cannot see drafts.
    assert.equal((await call("GET", "/api/partner/applications", { cookie: p.cookie, origin: null })).json.total, 0);
  });

  it("with the summary only, the partner sees the summary and nothing personal", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner(
      { businessName: "Obi Fabrics", address: "12 Allen Avenue", hasCac: "Yes", cacNumber: "RC7654321", hasTin: "Yes", tin: "12345678-0001", bankName: "Secret Bank", website: "obifabrics.com", instagram: "obi_fabrics" },
    );
    const sub = await apply(o, id, { consent: { summary: true } });
    assert.equal(sub.status, 201, JSON.stringify(sub.json));

    const detail = await call("GET", `/api/partner/applications/${sub.json.application.id}`, { cookie: p.cookie, origin: null });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.shared, ["summary"]);
    assert.equal(detail.json.applicant.summary.businessName, "Obi Fabrics");
    assert.equal(detail.json.applicant.summary.hasCac, "Yes", "a Yes or No only");
    assert.equal(detail.json.applicant.contact, undefined);
    assert.equal(detail.json.applicant.profile, undefined);
    const text = JSON.stringify(detail.json);
    for (const secret of secrets(o)) assert.ok(!text.includes(secret), `leaked: ${secret}`);
    assert.ok(!/referral|passwordHash|"owner"/i.test(text));
    assert.equal(detail.json.fit.label, "Eligible");
    assert.equal(detail.json.application.message, "Please consider us.");

    const list = await call("GET", "/api/partner/applications", { cookie: p.cookie, origin: null });
    const row = list.json.items[0];
    assert.equal(row.businessName, "Obi Fabrics");
    assert.deepEqual(Object.keys(row).sort(), ["businessName", "id", "opportunityId", "opportunityTitle", "state", "status", "submittedAt"]);
  });

  it("contact and profile are shared only when the owner chooses them", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner({ address: "12 Allen Avenue", hasCac: "Yes", cacNumber: "RC7654321", bankName: "Secret Bank" });
    const sub = await apply(o, id, { consent: { summary: true, contact: true, profile: true } });
    const detail = await call("GET", `/api/partner/applications/${sub.json.application.id}`, { cookie: p.cookie, origin: null });
    assert.deepEqual(detail.json.shared, ["summary", "contact", "profile"]);
    assert.equal(detail.json.applicant.contact.email, o.email);
    assert.equal(detail.json.applicant.contact.phone, o.phone);
    assert.equal(detail.json.applicant.profile.address, "12 Allen Avenue");
    assert.equal(detail.json.applicant.profile.cacNumber, "RC7654321");
    assert.equal(detail.json.applicant.profile.bankName, "Secret Bank");
    const text = JSON.stringify(detail.json);
    assert.ok(!/"(nin|bvn|accountNumber|referral)"/i.test(text), "no identity numbers exist to share");
  });

  it("records what was shared, with whom, why and when, and shows it to the owner", async () => {
    const p = await partner();
    const id = await openByPartner(p, { title: "Recorded programme" });
    const o = await owner();
    await apply(o, id, { consent: { summary: true, contact: true } });
    const res = await call("GET", "/api/consents", { cookie: o.cookie, origin: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 1);
    const c = res.json.items[0];
    assert.equal(c.sharedWith, p.name);
    assert.deepEqual(c.categories, ["summary", "contact"]);
    assert.match(c.purpose, /Recorded programme/);
    assert.ok(c.grantedAt);
    assert.equal(c.revokedAt, null);
    assert.equal(c.categoryDetails[0].label, "Business summary");
    assert.equal(c.owner, undefined);
    // Another owner has no access to it.
    const other = await owner();
    assert.equal((await call("GET", "/api/consents", { cookie: other.cookie, origin: null })).json.items.length, 0);
    // A platform run opportunity is shared with NMREP itself.
    const platform = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Run by us", provider: "NMREP", type: "Support", description: "x" } });
    await call("PATCH", `/api/admin/opportunities/${platform.json.opportunity.id}`, { cookie: admin, body: { status: "Open" } });
    const detail = await call("GET", `/api/opportunities/${platform.json.opportunity.id}`, { cookie: o.cookie, origin: null });
    assert.equal(detail.json.sharing.with, "NMREP");
    await apply(o, platform.json.opportunity.id);
    const again = await call("GET", "/api/consents", { cookie: o.cookie, origin: null });
    assert.equal(again.json.items[0].sharedWith, "NMREP");
  });

  it("withdrawing ends the sharing: the partner no longer sees the applicant", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner();
    const sub = await apply(o, id, { consent: { summary: true, contact: true } });
    const appId = sub.json.application.id;
    assert.ok((await call("GET", `/api/partner/applications/${appId}`, { cookie: p.cookie, origin: null })).json.applicant);
    assert.equal((await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie })).status, 200);
    const detail = await call("GET", `/api/partner/applications/${appId}`, { cookie: p.cookie, origin: null });
    assert.equal(detail.json.applicant, null);
    assert.equal(detail.json.application.message, "");
    assert.equal(detail.json.application.status, "Withdrawn");
    const list = await call("GET", "/api/partner/applications", { cookie: p.cookie, origin: null });
    assert.equal(list.json.items[0].businessName, null);
    const c = (await call("GET", "/api/consents", { cookie: o.cookie, origin: null })).json.items[0];
    assert.ok(c.revokedAt);
    assert.equal(c.revokedReason, "Application withdrawn");
  });

  it("platform admins still see the full application and the consent record", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner({ address: "12 Allen Avenue" });
    const sub = await apply(o, id, { consent: { summary: true } });
    const detail = await call("GET", `/api/admin/applications/${sub.json.application.id}`, { cookie: admin, origin: null });
    assert.equal(detail.json.application.snapshot.address, "12 Allen Avenue");
    assert.equal(detail.json.consents.length, 1);
    assert.equal(detail.json.opportunity.organisationName, p.name);
    const list = await call("GET", `/api/admin/applications?organisation=${p.orgId}`, { cookie: admin, origin: null });
    assert.equal(list.json.total, 1);
    assert.equal(list.json.items[0].organisationName, p.name);
    const none = await call("GET", `/api/admin/applications?organisation=${"c".repeat(24)}`, { cookie: admin, origin: null });
    assert.equal(none.json.total, 0);
  });
});

describe("application statuses from the framework", () => {
  it("a partner moves an application through screening, more information, waitlist, approval and completion", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner({ employees: 4 });
    const sub = await apply(o, id);
    const appId = sub.json.application.id;
    const move = (status, note = "Noted") => call("POST", `/api/partner/applications/${appId}/status`, { cookie: p.cookie, body: { status, note } });

    assert.equal((await move("Screening", "")).status, 422, "a note is needed");
    assert.equal((await move("Completed")).status, 422, "not straight to completed");
    assert.equal((await move("Withdrawn")).status, 422, "partners cannot withdraw");
    assert.equal((await move("Draft")).status, 422);
    assert.equal((await move("Screening")).status, 200);
    assert.equal((await move("More Information Required", "Please say how many staff are full time.")).status, 200);

    // The owner is told, and can answer.
    const notes = await call("GET", "/api/notifications", { cookie: o.cookie, origin: null });
    assert.ok(notes.json.items.some((n) => /more information required/i.test(n.title) && /full time/.test(n.body)));
    const view = await call("GET", `/api/applications/${appId}`, { cookie: o.cookie, origin: null });
    assert.equal(view.json.application.status, "More Information Required");

    await call("PATCH", "/api/business", { cookie: o.cookie, body: { employees: 9 } });
    const noConsent = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, message: "Nine, seven full time.", submit: true } });
    assert.equal(noConsent.status, 422, "answering shares again, so it asks again");
    const answer = await apply(o, id, { message: "Nine, seven full time.", consent: { summary: true, contact: true } });
    assert.equal(answer.status, 201, JSON.stringify(answer.json));
    assert.equal(answer.json.application.id, appId);
    assert.equal(answer.json.application.status, "Submitted");
    assert.equal(answer.json.application.snapshot.employees, 9, "the profile is copied again");
    assert.equal(answer.json.application.history.at(-1).note, "The applicant answered the request for more information");

    const consents = (await call("GET", "/api/consents", { cookie: o.cookie, origin: null })).json.items;
    assert.equal(consents.length, 2);
    assert.equal(consents.filter((c) => !c.revokedAt).length, 1, "only the newest agreement is active");

    assert.equal((await move("Under Review")).status, 200);
    assert.equal((await move("Waitlisted")).status, 200);
    assert.equal((await move("Under Review")).status, 422, "from the waitlist only a decision");
    assert.equal((await move("Approved", "Welcome")).status, 200);
    assert.equal((await move("Declined")).status, 422, "an approval cannot be reversed");
    assert.equal((await move("Completed", "Programme finished")).status, 200);
    assert.equal((await move("Approved")).status, 422, "completed is final");
    const final = await call("GET", `/api/partner/applications/${appId}`, { cookie: p.cookie, origin: null });
    assert.deepEqual(final.json.application.history.map((h) => h.status), [
      "Draft", "Submitted", "Screening", "More Information Required", "Submitted", "Under Review", "Waitlisted", "Approved", "Completed",
    ]);
    assert.deepEqual(final.json.allowed, []);
    assert.equal((await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie })).status, 409, "a completed application cannot be withdrawn");
  });

  it("owners can withdraw at any stage before a decision, including screening and the waitlist", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const o = await owner();
    const appId = (await apply(o, id)).json.application.id;
    await call("POST", `/api/partner/applications/${appId}/status`, { cookie: p.cookie, body: { status: "Screening", note: "Looking" } });
    const w = await call("POST", `/api/applications/${appId}/withdraw`, { cookie: o.cookie });
    assert.equal(w.status, 200);
    assert.equal(w.json.application.status, "Withdrawn");
  });

  it("an opportunity's beneficiary limit stops further approvals", async () => {
    const p = await partner();
    const id = await openByPartner(p, { beneficiaryLimit: 1 });
    const first = await owner();
    const second = await owner();
    const a1 = (await apply(first, id)).json.application.id;
    const a2 = (await apply(second, id)).json.application.id;
    const move = (appId, status) => call("POST", `/api/partner/applications/${appId}/status`, { cookie: p.cookie, body: { status, note: "Decision" } });
    assert.equal((await move(a1, "Approved")).status, 200);
    const blocked = await move(a2, "Approved");
    assert.equal(blocked.status, 422);
    assert.equal(blocked.json.error.code, "limit_reached");
    assert.equal((await move(a2, "Waitlisted")).status, 200, "waitlisting is still possible");
    // Admins are held to the same limit.
    const adminTry = await call("POST", `/api/admin/applications/${a2}/status`, { cookie: admin, body: { status: "Approved", note: "x" } });
    assert.equal(adminTry.status, 422);
    // Completing the first keeps the place taken.
    await move(a1, "Completed");
    assert.equal((await move(a2, "Approved")).status, 422);
  });

  it("lists only approved and completed applicants as beneficiaries, with only what they agreed to share", async () => {
    const p = await partner();
    const id = await openByPartner(p);
    const yes = await owner({ businessName: "Beneficiary Ltd", address: "1 Secret Street" });
    const no = await owner({ businessName: "Not chosen Ltd" });
    const a1 = (await apply(yes, id, { consent: { summary: true, contact: true } })).json.application.id;
    const a2 = (await apply(no, id)).json.application.id;
    await call("POST", `/api/partner/applications/${a1}/status`, { cookie: p.cookie, body: { status: "Approved", note: "Yes" } });
    await call("POST", `/api/partner/applications/${a2}/status`, { cookie: p.cookie, body: { status: "Declined", note: "No" } });
    const res = await call("GET", "/api/partner/beneficiaries", { cookie: p.cookie, origin: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 1);
    const item = res.json.items[0];
    assert.equal(item.applicant.summary.businessName, "Beneficiary Ltd");
    assert.equal(item.applicant.contact.email, yes.email);
    assert.equal(item.applicant.profile, undefined);
    assert.ok(!JSON.stringify(res.json).includes("1 Secret Street"));
    assert.ok(!JSON.stringify(res.json).includes("Not chosen"));
    const other = await partner();
    assert.equal((await call("GET", "/api/partner/beneficiaries", { cookie: other.cookie, origin: null })).json.items.length, 0);
  });

  it("the owner is notified of every decision", async () => {
    const p = await partner();
    const id = await openByPartner(p, { title: "Notify me" });
    const o = await owner();
    const appId = (await apply(o, id)).json.application.id;
    for (const [status, note] of [["Screening", "Screening now"], ["Under Review", "Under review now"], ["Waitlisted", "On the waitlist"], ["Approved", "Approved now"]]) {
      await call("POST", `/api/partner/applications/${appId}/status`, { cookie: p.cookie, body: { status, note } });
    }
    const notes = (await call("GET", "/api/notifications", { cookie: o.cookie, origin: null })).json.items.filter((n) => n.type === "application");
    assert.equal(notes.length, 4);
    assert.ok(notes.some((n) => n.title === "Application waitlisted: Notify me"));
  });
});

describe("partner reports, overview and the activity log", () => {
  it("count only the organisation's own data", async () => {
    const a = await partner();
    const b = await partner();
    const idA = await openByPartner(a, { title: "Report A" });
    await openByPartner(b, { title: "Report B" });
    const o1 = await owner({ state: "Kano", sector: "Manufacturing" });
    const o2 = await owner({ state: "Lagos", sector: "Retail and trading" });
    const app1 = (await apply(o1, idA)).json.application.id;
    await apply(o2, idA);
    await call("POST", `/api/partner/applications/${app1}/status`, { cookie: a.cookie, body: { status: "Approved", note: "ok" } });

    const overview = await call("GET", "/api/partner/overview", { cookie: a.cookie, origin: null });
    assert.equal(overview.json.organisation.name, a.name);
    assert.equal(overview.json.opportunities.Open, 1);
    assert.equal(overview.json.applications.Submitted, 1);
    assert.equal(overview.json.applications.Approved, 1);
    assert.equal(overview.json.beneficiaries, 1);

    const report = await call("GET", "/api/partner/reports", { cookie: a.cookie, origin: null });
    assert.equal(report.status, 200);
    assert.deepEqual(report.json.applicationsPerOpportunity.map((r) => [r.title, r.total, r.approved]), [["Report A", 2, 1]]);
    assert.deepEqual(report.json.applicantsByState.map((r) => r.name).sort(), ["Kano", "Lagos"]);
    const bOverview = await call("GET", "/api/partner/overview", { cookie: b.cookie, origin: null });
    assert.equal(bOverview.json.beneficiaries, 0);
    const bReport = await call("GET", "/api/partner/reports", { cookie: b.cookie, origin: null });
    assert.deepEqual(bReport.json.applicationsPerOpportunity, []);
  });

  it("partner and admin actions on organisations are recorded", async () => {
    const p = await partner("Microfinance Institution");
    const id = await openByPartner(p, { title: "Audited programme" });
    const o = await owner();
    const appId = (await apply(o, id)).json.application.id;
    await call("POST", `/api/partner/applications/${appId}/status`, { cookie: p.cookie, body: { status: "Approved", note: "Done" } });
    const log = await call("GET", "/api/admin/audit", { cookie: superAdmin, origin: null });
    const entries = log.json.items;
    assert.ok(entries.some((e) => e.action === "organisation.create" && e.summary.includes(p.name)));
    assert.ok(entries.some((e) => e.action === "partner.create"));
    assert.ok(entries.some((e) => e.action === "opportunity.submit" && /\(partner\)/.test(e.actorName)));
    assert.ok(entries.some((e) => e.action === "opportunity.approve"));
    assert.ok(entries.some((e) => e.action === "application.status" && /\(partner\)/.test(e.actorName)));
  });

  it("the organisation list counts people and opportunities", async () => {
    const p = await partner();
    await call("POST", "/api/partner/opportunities", { cookie: p.cookie, body: base });
    const list = await call("GET", "/api/admin/organisations", { cookie: admin, origin: null });
    const row = list.json.items.find((r) => r.id === p.orgId);
    assert.equal(row.people, 1);
    assert.equal(row.opportunities, 1);
    const detail = await call("GET", `/api/admin/organisations/${p.orgId}`, { cookie: admin, origin: null });
    assert.equal(detail.json.people.length, 1);
    assert.equal(detail.json.people[0].role, "partner");
    assert.equal(detail.json.opportunities.Draft, 1);
    assert.equal((await call("GET", `/api/admin/organisations/${"d".repeat(24)}`, { cookie: admin, origin: null })).status, 404);
    assert.equal((await call("PATCH", `/api/admin/organisations/${p.orgId}`, { cookie: admin, body: {} })).status, 422);
  });
});

describe("indexes", () => {
  it("organisation names are unique ignoring case", async () => {
    const { Organisation } = await import("../src/models/Organisation.js");
    await Organisation.init();
    const indexes = await Organisation.collection.indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.name === 1));
  });
});
