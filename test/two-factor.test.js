import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { base32, codeAt, newRecoveryCodes, otpauthUrl, stepAt, useRecoveryCode, verifyCode } from "../src/lib/two-factor.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startExtraApp, startTestServer } from "./helpers.js";
import { createStaff } from "./staff-helpers.js";

// Optional two-factor sign-in for staff with an authenticator app.

let ctx;
let call;
const KEY = crypto.randomBytes(32).toString("base64");

before(async () => {
  ctx = await startTestServer({ DOCUMENT_ENCRYPTION_KEY: KEY, RATE_LIMIT_LOGIN: "500" });
  call = client(ctx.base);
});
after(async () => {
  await ctx.stop();
});

const signIn = (s, extra = {}) => call("POST", "/api/auth/login", { body: { identifier: s.email, password: s.password, ...extra } });
const currentCode = (secret) => codeAt(secret, stepAt());

describe("the one-time code itself", () => {
  it("matches the RFC 6238 test value, and reads and writes base32", () => {
    const secret = base32.encode(Buffer.from("12345678901234567890"));
    assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(codeAt(secret, Math.floor(59 / 30)), "287082");
    assert.equal(base32.decode(secret).toString(), "12345678901234567890");
    assert.equal(base32.decode("gezd gnbv-gy3t").length, 7, "spaces, dashes and case are ignored");
  });

  it("accepts a code one step either side, never an older one, and never the same step twice", () => {
    const secret = base32.encode(crypto.randomBytes(20));
    const now = Date.UTC(2030, 0, 1, 12, 0, 10);
    const step = stepAt(now);
    assert.equal(verifyCode(secret, codeAt(secret, step), { now }), step);
    assert.equal(verifyCode(secret, codeAt(secret, step - 1), { now }), step - 1);
    assert.equal(verifyCode(secret, codeAt(secret, step + 1), { now }), step + 1);
    assert.equal(verifyCode(secret, codeAt(secret, step - 2), { now }), null);
    assert.equal(verifyCode(secret, codeAt(secret, step), { now, lastStep: step }), null, "already used");
    assert.equal(verifyCode(secret, "12345", { now }), null);
    assert.equal(verifyCode(secret, "abcdef", { now }), null);
  });

  it("recovery codes are single use and only their hashes are kept", () => {
    const { plain, hashes } = newRecoveryCodes();
    assert.equal(plain.length, 8);
    assert.match(plain[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(hashes.every((h) => !plain.includes(h)));
    const left = useRecoveryCode(hashes, plain[0].toLowerCase());
    assert.equal(left.length, 7);
    assert.equal(useRecoveryCode(left, plain[0]), null);
    assert.equal(useRecoveryCode(hashes, "NOPE-NOPE"), null);
    assert.match(otpauthUrl({ account: "a@b.c", secret: "ABC" }), /^otpauth:\/\/totp\/NMREP%3Aa%40b\.c\?secret=ABC&issuer=NMREP/);
  });
});

describe("setting it up and signing in", () => {
  it("the whole path: set up, confirm, sign in needs the code, a code works once, a recovery code works once", async () => {
    const s = await createStaff({ role: "admin" });
    const first = await signIn(s);
    assert.equal(first.status, 200, "no two-factor yet: a password is enough");
    const cookie = first.cookie;

    const status = await call("GET", "/api/account/two-factor", { cookie });
    assert.deepEqual(status.json, { available: true, enabled: false, recoveryCodesLeft: 0 });

    assert.equal((await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: "wrong-password-1" } })).status, 422);
    const setup = await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } });
    assert.equal(setup.status, 200, JSON.stringify(setup.json));
    const secret = setup.json.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(setup.json.otpauthUrl.includes(secret));
    const stored = await User.findById(s.user._id).select("+twoFactorSecret");
    assert.ok(stored.twoFactorSecret && !stored.twoFactorSecret.includes(secret), "the secret is stored encrypted");
    assert.equal(stored.twoFactorEnabled, false, "not on until a code is confirmed");

    assert.equal((await call("POST", "/api/account/two-factor/enable", { cookie, body: { code: "000000" } })).status, 422);
    const enabled = await call("POST", "/api/account/two-factor/enable", { cookie, body: { code: currentCode(secret) } });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    assert.equal(enabled.json.recoveryCodes.length, 8);
    assert.ok(await AuditLog.findOne({ action: "account.two-factor-on" }));
    assert.equal((await call("GET", "/api/account/two-factor", { cookie })).json.recoveryCodesLeft, 8);

    // The password alone no longer signs in.
    const need = await signIn(s);
    assert.equal(need.status, 401);
    assert.equal(need.json.error.code, "two_factor_required");
    assert.ok(!need.cookie, "no session was started");
    const bad = await signIn(s, { code: "111111" });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, "invalid_code");

    // The code used to confirm cannot be used again to sign in; the next step's code can.
    assert.equal((await signIn(s, { code: currentCode(secret) })).status, 401, "the step already used is refused");
    const next = codeAt(secret, stepAt() + 1);
    const ok = await signIn(s, { code: next });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(ok.cookie);
    assert.equal(ok.json.user.twoFactorEnabled, true);
    assert.ok(!JSON.stringify(ok.json).includes("twoFactorSecret"));
    assert.equal((await signIn(s, { code: next })).status, 401, "a code works once");

    // A recovery code signs in once.
    const rc = enabled.json.recoveryCodes[0];
    assert.equal((await signIn(s, { code: rc })).status, 200);
    assert.equal((await signIn(s, { code: rc })).status, 401);
    assert.equal((await call("GET", "/api/account/two-factor", { cookie: ok.cookie })).json.recoveryCodesLeft, 7);
  });

  it("switching it off needs the password and a code, and then the password alone works again", async () => {
    const s = await createStaff({ role: "admin" });
    const { cookie } = await signIn(s);
    const setup = await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } });
    const secret = setup.json.secret;
    const enabled = await call("POST", "/api/account/two-factor/enable", { cookie, body: { code: currentCode(secret) } });
    assert.equal((await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } })).status, 409, "already on");

    assert.equal((await call("POST", "/api/account/two-factor/disable", { cookie, body: { password: "nope-nope-1", code: enabled.json.recoveryCodes[0] } })).status, 422);
    assert.equal((await call("POST", "/api/account/two-factor/disable", { cookie, body: { password: s.password, code: "123456" } })).status, 422);
    const off = await call("POST", "/api/account/two-factor/disable", { cookie, body: { password: s.password, code: enabled.json.recoveryCodes[1] } });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal((await signIn(s)).status, 200);
    const user = await User.findOne({ email: s.email }).select("+twoFactorSecret +twoFactorRecovery");
    assert.equal(user.twoFactorSecret, "");
    assert.deepEqual(user.twoFactorRecovery, []);
  });

  it("is for staff only: an owner is refused", async () => {
    const owner = await call("POST", "/api/auth/register", {
      body: registrationBody(),
    });
    assert.equal(owner.status, 201);
    for (const [method, path] of [["GET", "/api/account/two-factor"], ["POST", "/api/account/two-factor/setup"]]) {
      assert.equal((await call(method, path, { cookie: owner.cookie, body: method === "POST" ? { password: "Secret123" } : undefined })).status, 403, path);
    }
  });

  it("a wrong code counts towards the lock-out like a wrong password", async () => {
    const s = await createStaff({ role: "admin" });
    const { cookie } = await signIn(s);
    const setup = await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } });
    await call("POST", "/api/account/two-factor/enable", { cookie, body: { code: currentCode(setup.json.secret) } });
    for (let i = 0; i < 5; i += 1) assert.equal((await signIn(s, { code: "000000" })).json.error.code, "invalid_code");
    // Locked: even the right code now gets the same answer as any other failure.
    const locked = await signIn(s, { code: codeAt(setup.json.secret, stepAt() + 1) });
    assert.equal(locked.status, 401);
    assert.equal(locked.json.error.code, "invalid_credentials");
  });

  it("the super admin can switch off a staff member's two-factor sign-in after a lost phone", async () => {
    const boss = await createStaff({ role: "super_admin" });
    const bossCookie = (await signIn(boss)).cookie;
    const s = await createStaff({ role: "admin" });
    const { cookie } = await signIn(s);
    const setup = await call("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } });
    await call("POST", "/api/account/two-factor/enable", { cookie, body: { code: currentCode(setup.json.secret) } });
    assert.equal((await signIn(s)).status, 401);
    const target = await User.findOne({ email: s.email });
    assert.equal((await call("POST", `/api/admin/admins/${target._id}/two-factor/reset`, { cookie })).status, 403, "an ordinary admin cannot");
    const reset = await call("POST", `/api/admin/admins/${target._id}/two-factor/reset`, { cookie: bossCookie });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal((await signIn(s)).status, 200);
    assert.ok(await AuditLog.findOne({ action: "admin.two-factor-reset" }));
  });
});

describe("without the server's encryption key", () => {
  it("says so, instead of half switching it on", async () => {
    const bare = await startExtraApp({ RATE_LIMIT_LOGIN: "500" });
    try {
      const c = client(bare.base);
      const s = await createStaff({ role: "admin" });
      const { cookie } = await c("POST", "/api/auth/login", { body: { identifier: s.email, password: s.password } });
      assert.equal((await c("GET", "/api/account/two-factor", { cookie })).json.available, false);
      const res = await c("POST", "/api/account/two-factor/setup", { cookie, body: { password: s.password } });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, "two_factor_unavailable");
    } finally {
      await bare.stop();
    }
  });
});
