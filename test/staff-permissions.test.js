import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { permissionKeys, permissionsOf, rolePresets } from "../src/lib/permissions.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// What each member of staff may do: roles (Admin, Operations), permissions picked by a super admin, and the checks on the server.

let ctx;
let call;
let superCookie;
let target; // a business the staff look at

before(async () => {
  ctx = await startTestServer({ RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
  const boss = await createStaff({ role: "super_admin" });
  superCookie = (await logIn(call, boss.email, boss.password)).cookie;
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business: { businessName: "Permission Test Co" } }) });
  assert.equal(res.status, 201, res.text);
  target = { id: res.json.business.id, email: res.json.user.email, phone: res.json.user.phone };
});
after(async () => {
  await ctx.stop();
});

/** A signed-in staff member with the given role and (optionally hand-picked) access. */
async function staff({ staffRole = "admin", permissions } = {}) {
  const s = await createStaff({ role: "admin" });
  await User.updateOne({ _id: s.user._id }, { staffRole, ...(permissions ? { permissionsCustom: true, permissions } : {}) });
  const { cookie } = await logIn(call, s.email, s.password);
  return { cookie, id: String(s.user._id), email: s.email };
}
const as = (who, method, path, body) => call(method, path, { cookie: who.cookie, ...(body ? { body } : {}) });

describe("the permission sets", () => {
  it("a super admin has everything, an admin has everything by default, operations only looks", () => {
    assert.deepEqual(permissionsOf({ role: "super_admin" }), permissionKeys);
    assert.deepEqual(permissionsOf({ role: "admin" }), permissionKeys, "an older admin with no choices made keeps full access");
    assert.deepEqual(permissionsOf({ role: "admin", staffRole: "operations" }), rolePresets.operations);
    assert.ok(!permissionsOf({ role: "admin", staffRole: "operations" }).includes("messages"));
    assert.deepEqual(permissionsOf({ role: "admin", permissionsCustom: true, permissions: ["verify", "nonsense"] }), ["verify"]);
    assert.deepEqual(permissionsOf({ role: "msme_owner" }), []);
  });
});

describe("an Operations account looks but changes and sends nothing", () => {
  it("can see businesses, verification, payments, reports and the owner's contact details", async () => {
    const ops = await staff({ staffRole: "operations" });
    for (const path of ["/api/admin/businesses", `/api/admin/businesses/${target.id}`, "/api/admin/verifications", "/api/admin/payments", "/api/admin/reports", "/api/admin/opportunities", "/api/admin/applications", "/api/admin/broadcasts"]) {
      assert.equal((await as(ops, "GET", path)).status, 200, path);
    }
    const detail = await as(ops, "GET", `/api/admin/businesses/${target.id}`);
    assert.equal(detail.json.owner.email, target.email, "operations may see personal details");
  });

  it("cannot verify, send messages, manage opportunities, partners or referral codes, or download spreadsheets", async () => {
    const ops = await staff({ staffRole: "operations" });
    const refused = [
      ["POST", `/api/admin/businesses/${target.id}/status`, { status: "Rejected", note: "No" }],
      ["PATCH", `/api/admin/businesses/${target.id}/account`, { active: false }],
      ["POST", "/api/admin/broadcasts", { title: "Hello", body: "Hi" }],
      ["POST", "/api/admin/opportunities", { title: "Grant" }],
      ["POST", "/api/admin/agents", { fullName: "Agent One", phone: "08012345678" }],
      ["POST", "/api/admin/organisations", { name: "Org", type: "Bank" }],
      ["GET", "/api/admin/export/businesses"],
      ["GET", "/api/admin/export/applications"],
      ["GET", "/api/admin/payments/export.csv"],
    ];
    for (const [method, path, body] of refused) {
      const res = await as(ops, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.error.code, "forbidden");
    }
  });
});

describe("access picked by hand", () => {
  it("someone allowed only to verify can verify but sees no payments and no personal details", async () => {
    const only = await staff({ permissions: ["verify"] });
    assert.equal((await as(only, "GET", "/api/admin/payments")).status, 403);
    const list = await as(only, "GET", "/api/admin/businesses");
    assert.equal(list.status, 200);
    assert.ok(list.json.items.every((i) => i.email === ""), "owner emails are hidden in the list");
    const detail = await as(only, "GET", `/api/admin/businesses/${target.id}`);
    assert.equal(detail.json.owner.email, "");
    assert.equal(detail.json.owner.phone, "");
    assert.equal(detail.json.owner.fullName.length > 0, true, "the name is still shown");
    const queue = await as(only, "GET", "/api/admin/verifications?status=all");
    assert.ok(queue.json.items.every((i) => i.ownerEmail === "" && i.ownerPhone === ""));
    assert.equal((await as(only, "GET", `/api/admin/businesses/${target.id}/documents/000000000000000000000000`)).status, 403, "documents need the personal details permission");
    const verified = await as(only, "POST", `/api/admin/businesses/${target.id}/status`, { status: "Pending Verification", note: "Looking at it." });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
  });

  it("someone allowed to export but not to see personal details gets a file with those columns empty", async () => {
    const exp = await staff({ permissions: ["export"] });
    const res = await as(exp, "GET", "/api/admin/export/businesses");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Permission Test Co"));
    assert.ok(!res.text.includes(target.email) && !res.text.includes(target.phone));
  });

  it("someone allowed to send messages can, and an admin without that permission cannot", async () => {
    const sender = await staff({ permissions: ["messages"] });
    const none = await staff({ permissions: [] });
    assert.notEqual((await as(sender, "POST", "/api/admin/broadcasts", { audience: "all" })).status, 403, "the guard lets the request through to validation");
    assert.equal((await as(none, "POST", "/api/admin/broadcasts", { audience: "all" })).status, 403);
    assert.equal((await as(none, "GET", "/api/admin/businesses")).status, 200, "everyone on staff can still look at businesses");
  });
});

describe("the super admin chooses the role and the access", () => {
  it("creates an admin with a role and hand picked access, and the answer says what they have", async () => {
    const res = await as({ cookie: superCookie }, "POST", "/api/admin/admins", { fullName: "Op Erations", email: "ops-new@example.com", phone: "08011112222", staffRole: "operations" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.admin.staffRole, "operations");
    assert.deepEqual(res.json.admin.permissions, rolePresets.operations);

    const custom = await as({ cookie: superCookie }, "POST", "/api/admin/admins", { fullName: "Pay Only", email: "pay-only@example.com", phone: "08011113333", staffRole: "admin", permissions: ["payments", "export"] });
    assert.equal(custom.status, 201);
    assert.deepEqual(custom.json.admin.permissions, ["payments", "export"]);
    assert.ok(await AuditLog.findOne({ action: "admin.create", summary: /payments, export/ }));

    const plain = await as({ cookie: superCookie }, "POST", "/api/admin/admins", { fullName: "Plain Admin", email: "plain-admin@example.com", phone: "08011114444" });
    assert.equal(plain.json.admin.staffRole, "admin");
    assert.deepEqual(plain.json.admin.permissions, permissionKeys, "no choice means the usual administrator access");
  });

  it("changes a role or access later, and it applies on the very next request", async () => {
    const admin = await staff();
    assert.notEqual((await as(admin, "GET", "/api/admin/payments")).status, 403);
    const down = await as({ cookie: superCookie }, "PATCH", `/api/admin/admins/${admin.id}`, { permissions: ["verify"] });
    assert.equal(down.status, 200, JSON.stringify(down.json));
    assert.deepEqual(down.json.admin.permissions, ["verify"]);
    assert.equal((await as(admin, "GET", "/api/admin/payments")).status, 403, "the change is immediate");
    const role = await as({ cookie: superCookie }, "PATCH", `/api/admin/admins/${admin.id}`, { staffRole: "operations" });
    assert.deepEqual(role.json.admin.permissions, rolePresets.operations, "a new role brings its usual access");
    assert.equal((await as(admin, "GET", "/api/admin/payments")).status, 200);
    assert.equal((await as({ cookie: superCookie }, "PATCH", `/api/admin/admins/${admin.id}`, { active: false })).status, 200);
    assert.ok(await AuditLog.findOne({ action: "admin.update", summary: /access set to: verify/ }));
  });

  it("refuses unknown access names, an empty change, and anyone who is not a super admin", async () => {
    const admin = await staff();
    assert.equal((await as({ cookie: superCookie }, "POST", "/api/admin/admins", { fullName: "X Y", email: "bad-perm@example.com", phone: "08011115555", permissions: ["everything"] })).status, 422);
    assert.equal((await as({ cookie: superCookie }, "PATCH", `/api/admin/admins/${admin.id}`, {})).status, 422);
    assert.equal((await as({ cookie: superCookie }, "PATCH", `/api/admin/admins/${admin.id}`, { staffRole: "owner" })).status, 422);
    assert.equal((await as(admin, "PATCH", `/api/admin/admins/${admin.id}`, { permissions: permissionKeys })).status, 403);
    assert.equal((await as(admin, "POST", "/api/admin/admins", { fullName: "A B", email: "x-new@example.com", phone: "08011116666" })).status, 403);
  });

  it("the signed-in user carries their access, for the screens to use", async () => {
    const ops = await staff({ staffRole: "operations" });
    const me = await as(ops, "GET", "/api/auth/me");
    assert.deepEqual(me.json.user.permissions, rolePresets.operations);
    assert.equal(me.json.user.staffRole, "operations");
    const boss = await as({ cookie: superCookie }, "GET", "/api/auth/me");
    assert.deepEqual(boss.json.user.permissions, permissionKeys);
    const owner = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal(owner.json.user.permissions, undefined, "owners have no staff access list");
  });
});
