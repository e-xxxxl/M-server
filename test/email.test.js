import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createMailer, setMailer } from "../src/lib/mailer.js";
import { EmailToken } from "../src/models/EmailToken.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startExtraApp, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let admin;

/** A mailer that only records what would have been sent. */
const fake = { enabled: true, sent: [], async send(message) { this.sent.push(message); return { ok: true }; } };
const sentTo = (email) => fake.sent.filter((m) => m.to === email);
const tokenIn = (message) => /#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  await ctx.stop();
});
beforeEach(() => {
  fake.sent = [];
  setMailer(fake, { notifications: true, appUrl: "https://nmrep.test" });
});

async function owner(account = {}) {
  const body = registrationBody({ account });
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { email: body.account.email, password: body.account.password, cookie: res.cookie, businessId: res.json.business.id };
}

describe("the Resend client", () => {
  const settings = { apiKey: "re_test_key_123", from: "NMREP <no-reply@nmrep.test>", replyTo: "help@nmrep.test" };

  it("posts the message to Resend with the key in the header and nothing else secret", async () => {
    const calls = [];
    const mailer = createMailer(settings, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ id: "msg_1" }) };
      },
    });
    const result = await mailer.send({ to: "a@example.com", subject: "Hello", text: "Plain", html: "<p>Html</p>" });
    assert.deepEqual(result, { ok: true, id: "msg_1" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key_123");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { from: settings.from, to: ["a@example.com"], subject: "Hello", text: "Plain", html: "<p>Html</p>", reply_to: "help@nmrep.test" });
    assert.ok(!calls[0].init.body.includes("re_test_key_123"), "the key is never in the body");
  });

  it("never throws, and never logs the key or the message when Resend refuses or the network fails", async () => {
    const logged = [];
    const log = { log: (...a) => logged.push(a.join(" ")), error: (...a) => logged.push(a.join(" ")) };
    const refusing = createMailer(settings, { log, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ name: "validation_error" }) }) });
    assert.deepEqual(await refusing.send({ to: "a@example.com", subject: "S", text: "secret one-time link", html: "" }), { ok: false, status: 403 });
    const broken = createMailer(settings, { log, fetchImpl: async () => { throw new TypeError("network down"); } });
    assert.deepEqual(await broken.send({ to: "a@example.com", subject: "S", text: "secret one-time link", html: "" }), { ok: false });
    const text = logged.join("\n");
    assert.ok(!text.includes("re_test_key_123"), "no key in logs");
    assert.ok(!text.includes("secret one-time link"), "no message body in logs");
  });

  it("is off without a key: nothing is sent, and the message is printed only outside production", async () => {
    let fetched = false;
    const logged = [];
    const log = { log: (...a) => logged.push(a.join(" ")), error: () => {} };
    const dev = createMailer({ apiKey: "", from: "" }, { log, isProd: false, fetchImpl: async () => { fetched = true; } });
    assert.equal(dev.enabled, false);
    assert.deepEqual(await dev.send({ to: "a@example.com", subject: "Dev", text: "link", html: "" }), { ok: false, skipped: true });
    assert.equal(fetched, false);
    assert.equal(logged.length, 1);
    const prod = createMailer({ apiKey: "", from: "" }, { log, isProd: true });
    await prod.send({ to: "a@example.com", subject: "Prod", text: "link", html: "" });
    assert.equal(logged.length, 1, "nothing is printed in production");
    assert.equal(createMailer({ apiKey: "re_x", from: "" }).enabled, false, "a key without a sender address is not enough");
  });
});

describe("forgot password", () => {
  it("gives the same answer for any address and sends mail only to a real, active account", async () => {
    const o = await owner();
    const unknown = await call("POST", "/api/auth/forgot-password", { body: { email: "nobody@example.com" } });
    const known = await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.json, known.json);
    assert.equal(sentTo("nobody@example.com").length, 0);
    const mails = sentTo(o.email).filter((m) => /Reset your NMREP password/.test(m.subject));
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /^.*https:\/\/nmrep\.test\/reset-password\/#token=[A-Za-z0-9_-]{40,}/m, "the token is after a #, never in the query");
    assert.ok(!/\?token=/.test(mails[0].text + mails[0].html));
    assert.ok(mails[0].html.includes("/reset-password/#token="));
  });

  it("stores only a hash of the token, and asking again within a minute sends nothing more", async () => {
    const o = await owner();
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    const token = tokenIn(sentTo(o.email).find((m) => /Reset/.test(m.subject)));
    const records = await EmailToken.find({ type: "reset" });
    assert.ok(records.length >= 1);
    assert.ok(!records.some((r) => r.tokenHash === token), "the token itself is not stored");
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    assert.equal(sentTo(o.email).filter((m) => /Reset/.test(m.subject)).length, 1);
  });

  it("sends nothing to a deactivated account, and rejects a malformed address", async () => {
    const o = await owner();
    await User.updateOne({ email: o.email }, { $set: { active: false } });
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: o.email } })).status, 200);
    assert.equal(sentTo(o.email).filter((m) => /Reset/.test(m.subject)).length, 0);
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: "not-an-email" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: o.email, extra: 1 } })).status, 422);
  });

  it("works for staff too, so a forgotten temporary password is not a dead end", async () => {
    const s = await createStaff({ role: "admin" });
    await call("POST", "/api/auth/forgot-password", { body: { email: s.email } });
    assert.equal(sentTo(s.email).filter((m) => /Reset/.test(m.subject)).length, 1);
  });
});

describe("reset password", () => {
  async function requestToken(o) {
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    return tokenIn(sentTo(o.email).find((m) => /Reset/.test(m.subject)));
  }

  it("sets the new password, signs out every session, clears a lock and works only once", async () => {
    const o = await owner();
    // Lock the account with wrong passwords, and keep a session open.
    const open = await logIn(call, o.email, o.password);
    for (let i = 0; i < 5; i += 1) await logIn(call, o.email, "WrongPass1");
    assert.equal((await logIn(call, o.email, o.password)).status, 401, "locked");

    const token = await requestToken(o);
    const res = await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "BrandNewPass9" } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json, { ok: true });

    assert.equal((await call("GET", "/api/dashboard", { cookie: open.cookie, origin: null })).status, 401, "the old session is gone");
    assert.equal((await logIn(call, o.email, o.password)).status, 401, "the old password no longer works");
    assert.equal((await logIn(call, o.email, "BrandNewPass9")).status, 200, "the lock was cleared and the new password works");

    const again = await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "AnotherPass7" } });
    assert.equal(again.status, 422);
    assert.equal(again.json.error.code, "invalid_token");

    const changed = sentTo(o.email).find((m) => /password was changed/.test(m.subject));
    assert.ok(changed, "the owner is told");
    assert.ok(!changed.text.includes("BrandNewPass9") && !changed.html.includes("BrandNewPass9"), "no password in the email");
  });

  it("refuses weak passwords, malformed, unknown and expired tokens", async () => {
    const o = await owner();
    const token = await requestToken(o);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "short" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "nodigitshere" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: "short", newPassword: "GoodPass12" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: { $ne: "" }, newPassword: "GoodPass12" } })).status, 422, "an operator object is not a token");
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: "A".repeat(43), newPassword: "GoodPass12" } })).json.error.code, "invalid_token");
    // Still usable after those failures, until it expires.
    await EmailToken.updateMany({ user: (await User.findOne({ email: o.email }))._id, type: "reset" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "GoodPass12" } });
    assert.equal(expired.status, 422);
    assert.equal(expired.json.error.code, "invalid_token");
    assert.equal((await logIn(call, o.email, o.password)).status, 200, "the password was not changed");
  });

  it("a newer link replaces an older one", async () => {
    const o = await owner();
    const first = await requestToken(o);
    await EmailToken.updateMany({ type: "reset" }, { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    fake.sent = [];
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    const second = tokenIn(sentTo(o.email).find((m) => /Reset/.test(m.subject)));
    assert.notEqual(first, second);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: first, newPassword: "GoodPass12" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: second, newPassword: "GoodPass12" } })).status, 200);
  });

  it("replaces a staff member's temporary password", async () => {
    const s = await createStaff({ role: "admin", mustChangePassword: true });
    const token = await requestToken(s);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "StaffNewPass1" } })).status, 200);
    const login = await logIn(call, s.email, "StaffNewPass1");
    assert.equal(login.status, 200);
    assert.equal(login.json.user.mustChangePassword, false);
  });
});

describe("confirming an email address", () => {
  it("registration sends a confirmation link that marks the address as confirmed, once", async () => {
    const o = await owner();
    const mails = sentTo(o.email).filter((m) => /Confirm your email/.test(m.subject));
    assert.equal(mails.length, 1);
    const me = await call("GET", "/api/auth/me", { cookie: o.cookie, origin: null });
    assert.equal(me.json.user.emailVerifiedAt, null);

    const token = tokenIn(mails[0]);
    assert.match(mails[0].text, /\/verify-email\/#token=/);
    const ok = await call("POST", "/api/auth/verify-email", { body: { token } });
    assert.equal(ok.status, 200);
    const after = await call("GET", "/api/auth/me", { cookie: o.cookie, origin: null });
    assert.ok(after.json.user.emailVerifiedAt);
    const again = await call("POST", "/api/auth/verify-email", { body: { token } });
    assert.equal(again.json.error.code, "invalid_token");
    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token: "nope" } })).status, 422);
    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token: tokenIn(mails[0]), x: 1 } })).status, 422);
  });

  it("a reset link cannot confirm an email address, and the other way round", async () => {
    const o = await owner();
    await call("POST", "/api/auth/forgot-password", { body: { email: o.email } });
    const reset = tokenIn(sentTo(o.email).find((m) => /Reset/.test(m.subject)));
    const verify = tokenIn(sentTo(o.email).find((m) => /Confirm/.test(m.subject)));
    assert.equal((await call("POST", "/api/auth/verify-email", { body: { token: reset } })).status, 422);
    assert.equal((await call("POST", "/api/auth/reset-password", { body: { token: verify, newPassword: "GoodPass12" } })).status, 422);
  });

  it("the owner can ask for the email again, at most once a minute, and not when already confirmed", async () => {
    const o = await owner();
    const first = await call("POST", "/api/account/resend-verification", { cookie: o.cookie });
    assert.equal(first.status, 200);
    assert.equal(sentTo(o.email).filter((m) => /Confirm/.test(m.subject)).length, 1, "registration just sent one");
    await EmailToken.updateMany({ type: "verify" }, { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await call("POST", "/api/account/resend-verification", { cookie: o.cookie });
    assert.equal(sentTo(o.email).filter((m) => /Confirm/.test(m.subject)).length, 2);
    const token = tokenIn(sentTo(o.email).filter((m) => /Confirm/.test(m.subject)).at(-1));
    await call("POST", "/api/auth/verify-email", { body: { token } });
    const done = await call("POST", "/api/account/resend-verification", { cookie: o.cookie });
    assert.deepEqual(done.json, { ok: true, alreadyVerified: true });
    assert.equal((await call("POST", "/api/account/resend-verification", {})).status, 401);
  });
});

describe("notification emails", () => {
  async function openOpportunity() {
    const created = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Mail grant", provider: "NMREP", type: "Grant", description: "x" } });
    const id = created.json.opportunity.id;
    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Open" } });
    return id;
  }

  it("owners get a short email for a verification change and for an application decision, with no staff note in it", async () => {
    const o = await owner();
    const note = "Private reviewer remark 8841";
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note } });
    const verification = sentTo(o.email).find((m) => /verification status/i.test(m.subject));
    assert.ok(verification);
    assert.match(verification.text, /https:\/\/nmrep\.test\/dashboard\//);
    assert.ok(!verification.text.includes(note) && !verification.html.includes(note));

    const id = await openOpportunity();
    const sub = await call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, submit: true, consent: { summary: true } } });
    await call("POST", `/api/admin/applications/${sub.json.application.id}/status`, { cookie: admin, body: { status: "Approved", note } });
    const decision = sentTo(o.email).find((m) => /Application approved/.test(m.subject));
    assert.ok(decision);
    assert.ok(!decision.text.includes(note) && !decision.html.includes(note));
  });

  it("announcements of new opportunities stay in the app and are not emailed", async () => {
    const o = await owner();
    fake.sent = [];
    await openOpportunity();
    assert.equal(sentTo(o.email).length, 0);
  });

  it("can be switched off, and nothing is sent when email is off", async () => {
    const o = await owner();
    setMailer(fake, { notifications: false });
    fake.sent = [];
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Pending Verification", note: "Checking" } });
    assert.equal(sentTo(o.email).length, 0);
    const off = { enabled: false, sent: [], async send(m) { this.sent.push(m); return { ok: false, skipped: true }; } };
    setMailer(off, { notifications: true });
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "Done" } });
    assert.equal(off.sent.length, 0, "no attempt at all while email is off");
    const note = await call("GET", "/api/notifications", { cookie: o.cookie, origin: null });
    assert.ok(note.json.items.some((n) => n.type === "verification"), "the in-app notification is still created");
    // Everything else still works without email.
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: o.email } })).status, 200);
  });

  it("a mail service that fails does not break the action", async () => {
    const o = await owner();
    setMailer({ enabled: true, async send() { return { ok: false, status: 500 }; } }, { notifications: true });
    const res = await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "Fine" } });
    assert.equal(res.status, 200);
    assert.equal((await call("POST", "/api/auth/forgot-password", { body: { email: o.email } })).status, 200);
    const reg = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal(reg.status, 201, "sign-up works even when the confirmation email cannot be sent");
  });
});

describe("rate limit on the email endpoints", () => {
  it("answers 429 after too many requests from one address", async () => {
    const extra = await startExtraApp({ RATE_LIMIT_RESET: "3" });
    try {
      const limited = client(extra.base);
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await limited("POST", "/api/auth/forgot-password", { body: { email: "x@example.com" } })).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal((await limited("POST", "/api/auth/reset-password", { body: { token: "A".repeat(43), newPassword: "GoodPass12" } })).status, 429);
    } finally {
      await extra.stop();
    }
  });
});

describe("indexes", () => {
  it("email tokens are unique and expire by themselves", async () => {
    await EmailToken.init();
    const indexes = await EmailToken.collection.indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.tokenHash === 1));
    assert.ok(indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
  });
});
