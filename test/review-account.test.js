import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createReviewAccount, inspectReviewAccount, makeReviewPassword } from "../src/lib/review-account.js";
import { Business } from "../src/models/Business.js";
import { User } from "../src/models/User.js";
import { passwordSchema } from "../src/schemas.js";
import { client, startTestServer } from "./helpers.js";

// The account a store reviewer signs in with.

let ctx;
let call;
let n = 0;
const mail = () => `reviewer${(n += 1)}-${Date.now()}@example.com`;
const phone = () => `+23480${String(70000000 + (n += 1))}`;

before(async () => {
  ctx = await startTestServer({ PAYSTACK_SECRET_KEY: "sk_test_not_a_real_key_for_tests" });
  call = client(ctx.base);
});
after(async () => {
  await ctx.stop();
});

describe("the review password", () => {
  it("is long, random, easy to type and accepted by the password rules", () => {
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) {
      const p = makeReviewPassword();
      assert.ok(passwordSchema.safeParse(p).success, p);
      assert.match(p, /^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{4}$/);
      assert.ok(!/[01OIl]/.test(p), "no look-alike characters");
      seen.add(p);
    }
    assert.equal(seen.size, 50);
  });
});

describe("creating the review account", () => {
  it("makes an owner who can sign in at once, with the fee already paid and nothing to confirm", async () => {
    const email = mail();
    const made = await createReviewAccount(ctx.config, { email, phone: phone(), years: 2 });
    assert.equal(made.created, true);
    const login = await call("POST", "/api/auth/login", { body: { identifier: email, password: made.password } });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.registration.paid, true);
    assert.equal(login.json.user.role, "msme_owner");
    assert.ok(login.json.user.emailVerifiedAt);
    assert.equal(login.json.business.businessName, "Google Play Review Business");
    // Past the paywall: a normal owner endpoint answers instead of 402.
    assert.equal((await call("GET", "/api/dashboard", { cookie: login.cookie })).status, 200);
    const days = (made.paidUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 2 * 365 - 1 && days < 2 * 365 + 1, String(days));
  });

  it("keeps only a hash of the password", async () => {
    const made = await createReviewAccount(ctx.config, { email: mail(), phone: phone() });
    const user = await User.findOne({ email: made.email }).select("+passwordHash").lean();
    assert.ok(user.passwordHash.startsWith("$2"));
    assert.ok(!JSON.stringify(user).includes(made.password));
  });

  it("refuses to touch an existing account unless asked to reset it", async () => {
    const email = mail();
    await createReviewAccount(ctx.config, { email, phone: phone() });
    await assert.rejects(createReviewAccount(ctx.config, { email, phone: phone() }), { code: "exists" });
  });

  it("resets the password of the existing account and adds paid time, and the old password stops working", async () => {
    const email = mail();
    const first = await createReviewAccount(ctx.config, { email, phone: phone(), years: 1 });
    const again = await createReviewAccount(ctx.config, { email, phone: phone(), years: 3, resetPassword: true });
    assert.equal(again.created, false);
    assert.notEqual(again.password, first.password);
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: email, password: first.password } })).status, 401);
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: email, password: again.password } })).status, 200);
    assert.equal(await Business.countDocuments({ owner: (await User.findOne({ email }))._id }), 1, "still one business");
  });

  it("never turns a staff account into a review account", async () => {
    const staff = await User.create({ fullName: "Staff", email: mail(), phone: phone(), passwordHash: "x", role: "admin" });
    await assert.rejects(createReviewAccount(ctx.config, { email: staff.email, phone: phone(), resetPassword: true }), { code: "not_owner" });
  });

  it("can mark the sample business verified and gives it an ID", async () => {
    const made = await createReviewAccount(ctx.config, { email: mail(), phone: phone(), verified: true });
    const business = await Business.findOne({ owner: (await User.findOne({ email: made.email }))._id });
    assert.equal(business.verificationStatus, "Verified");
    assert.match(business.nmrepId, /^NMREP-\d{4}-\d{8}$/);
  });
});

describe("checking the review account", () => {
  const problems = (results) => results.filter((r) => r.ok === false).map((r) => r.label);

  it("finds nothing wrong with a fresh account, and confirms the right password only", async () => {
    const made = await createReviewAccount(ctx.config, { email: mail(), phone: phone() });
    const ok = await inspectReviewAccount(ctx.config, { email: made.email, password: made.password });
    assert.deepEqual(problems(ok), [], JSON.stringify(ok.filter((r) => r.ok === false)));
    assert.equal(ok.find((r) => r.label === "Documents screen works").ok, null, "server settings are information, not a fault of the account");
    assert.ok(ok.find((r) => r.label === "The password you typed is correct").ok);
    const wrong = await inspectReviewAccount(ctx.config, { email: made.email, password: "Not-the-one-1" });
    assert.equal(wrong.find((r) => r.label === "The password you typed is correct").ok, false);
  });

  it("says so when the account does not exist", async () => {
    const r = await inspectReviewAccount(ctx.config, { email: mail() });
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, false);
  });

  it("flags every way the account could fail a reviewer", async () => {
    const made = await createReviewAccount(ctx.config, { email: mail(), phone: phone() });
    const user = await User.findOne({ email: made.email });
    user.registrationPaidUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    user.emailVerifiedAt = null;
    user.lockUntil = new Date(Date.now() + 60_000);
    await user.save();
    await Business.updateOne({ owner: user._id }, { $set: { verificationStatus: "Suspended" } });
    const bad = problems(await inspectReviewAccount(ctx.config, { email: made.email }));
    for (const expected of ["There is enough paid time for a store review", "The email is confirmed (no banner)", "It is not locked after failed sign-ins", "The business is not suspended"]) assert.ok(bad.includes(expected), expected);

    user.registrationPaidUntil = new Date(Date.now() - 1000);
    await user.save();
    assert.ok(problems(await inspectReviewAccount(ctx.config, { email: made.email })).includes("The registration fee is paid (no payment page)"));
  });

  it("changes nothing", async () => {
    const made = await createReviewAccount(ctx.config, { email: mail(), phone: phone() });
    const before = JSON.stringify(await User.findOne({ email: made.email }).select("+passwordHash").lean());
    await inspectReviewAccount(ctx.config, { email: made.email, password: made.password });
    assert.equal(JSON.stringify(await User.findOne({ email: made.email }).select("+passwordHash").lean()), before);
  });
});
