import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { flushBroadcasts } from "../src/lib/broadcast.js";
import { mailer, setMailer } from "../src/lib/mailer.js";
import { setPushSender } from "../src/lib/push.js";
import { runDeadlineReminders } from "../src/lib/reminders.js";
import { Device } from "../src/models/Device.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { Opportunity } from "../src/models/Opportunity.js";
import { User } from "../src/models/User.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

let ctx;
let call;
let admin;

const mails = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { ok: true }; } };
const pushes = { enabled: true, batches: [], invalid: [], async send(messages) { this.batches.push(messages); return { sent: messages.length - this.invalid.length, invalidTokens: this.invalid }; } };
const allPushes = () => pushes.batches.flat();
const sentTo = (email) => mails.sent.filter((m) => m.to === email);

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
  mails.sent = [];
  pushes.batches = [];
  pushes.invalid = [];
  setMailer(mails, { notifications: true, appUrl: "https://nmrep.test" });
  setPushSender(pushes);
});

let n = 100;
async function owner(account = {}, business = {}) {
  const body = registrationBody({ account, business });
  const res = await call("POST", "/api/auth/register", { body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, email: body.account.email, phone: body.account.phone, password: body.account.password, userId: res.json.user.id, businessId: res.json.business.id };
}
const token = (i) => `ExponentPushToken[abcdefghijklmnopqrst${String(i).padStart(4, "0")}]`;
const register = (o, t, platform = "android") => call("POST", "/api/devices", { cookie: o.cookie, body: { token: t, platform } });

describe("signing in with a phone number", () => {
  it("works with the number written any usual way, and with the email as before", async () => {
    const o = await owner({ phone: "0801 555 0142" });
    for (const identifier of ["08015550142", "+234 801 555 0142", "2348015550142", "0801-555-0142", o.email, o.email.toUpperCase()]) {
      const res = await call("POST", "/api/auth/login", { body: { identifier, password: o.password } });
      assert.equal(res.status, 200, identifier);
      assert.equal(res.json.user.email, o.email);
    }
    // The old field name still works, with an email or a phone number in it.
    assert.equal((await call("POST", "/api/auth/login", { body: { email: o.email, password: o.password } })).status, 200);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "08015550142", password: o.password } })).status, 200);
    // The phone key is never shown.
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: o.email, password: o.password } })).json.user.phoneKey, undefined);
  });

  it("answers the same for a wrong password, an unknown number and an unknown email", async () => {
    const o = await owner({ phone: "0801 555 0143" });
    const wrong = await call("POST", "/api/auth/login", { body: { identifier: "08015550143", password: "nope-nope-1" } });
    const unknown = await call("POST", "/api/auth/login", { body: { identifier: "08099990000", password: o.password } });
    const noAccount = await call("POST", "/api/auth/login", { body: { identifier: "nobody@example.com", password: o.password } });
    const junk = await call("POST", "/api/auth/login", { body: { identifier: "12", password: o.password } });
    for (const r of [wrong, unknown, noAccount, junk]) {
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, "invalid_credentials");
      assert.equal(r.json.error.message, wrong.json.error.message);
    }
    assert.equal((await call("POST", "/api/auth/login", { body: { password: "x" } })).status, 422);
  });

  it("a phone number belongs to one account: sign-up and a phone change are refused when it is taken", async () => {
    const a = await owner({ phone: "0801 555 0144" });
    const dup = await call("POST", "/api/auth/register", { body: registrationBody({ account: { phone: "+234 801 555 0144" } }) });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "phone_taken");
    assert.ok(dup.json.error.fields["account.phone"]);

    const b = await owner({ phone: "0801 555 0145" });
    const change = await call("PATCH", "/api/account", { cookie: b.cookie, body: { phone: "08015550144" } });
    assert.equal(change.status, 409);
    assert.equal((await call("PATCH", "/api/account", { cookie: b.cookie, body: { phone: "08015550146" } })).status, 200);
    assert.equal((await call("PATCH", "/api/account", { cookie: a.cookie, body: { phone: "08015550144" } })).status, 200, "keeping your own number is fine");
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "08015550146", password: b.password } })).status, 200, "the new number signs in");
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "08015550145", password: b.password } })).status, 401, "the old one no longer does");
  });

  it("refuses to guess when two old accounts share a number", async () => {
    const a = await owner({ phone: "0801 555 0150" });
    const b = await owner({ phone: "0801 555 0151" });
    await User.updateOne({ _id: b.userId }, { $set: { phone: "0801 555 0150", phoneKey: "2348015550150" } });
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "08015550150", password: a.password } })).status, 401);
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: a.email, password: a.password } })).status, 200, "email still works");
  });
});

describe("phones for push notifications", () => {
  it("registers an Expo token, refreshes it, moves it to whoever signs in on that phone, and removes it", async () => {
    const a = await owner();
    const b = await owner();
    assert.equal((await register(a, "not-a-token")).status, 422);
    assert.equal((await call("POST", "/api/devices", { cookie: a.cookie, body: { token: token(1), platform: "windows" } })).status, 422);
    assert.equal((await call("POST", "/api/devices", { body: { token: token(1), platform: "ios" } })).status, 401);

    const first = await register(a, token(1), "ios");
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.device.platform, "ios");
    assert.equal(first.json.device.user, undefined);
    assert.equal((await register(a, token(1), "ios")).status, 201);
    assert.equal(await Device.countDocuments({ token: token(1) }), 1, "the same phone is one record");

    await register(b, token(1), "ios");
    const moved = await Device.findOne({ token: token(1) });
    assert.equal(String(moved.user), b.userId);

    assert.equal((await call("DELETE", "/api/devices", { cookie: a.cookie, body: { token: token(1) } })).status, 204);
    assert.equal(await Device.countDocuments({ token: token(1) }), 1, "an account cannot remove another's phone");
    assert.equal((await call("DELETE", "/api/devices", { cookie: b.cookie, body: { token: token(1) } })).status, 204);
    assert.equal(await Device.countDocuments({ token: token(1) }), 0);
  });

  it("keeps the ten most recent phones of an account", async () => {
    const a = await owner();
    for (let i = 10; i < 22; i += 1) await register(a, token(i));
    assert.equal(await Device.countDocuments({ user: a.userId }), 10);
  });
});

describe("push notifications", () => {
  it("sends the headline of a verification change to the owner's phones, with no staff note, and respects the owner's choice", async () => {
    const o = await owner();
    await register(o, token(30));
    await register(o, token(31), "ios");
    const note = "Private reviewer remark 5521";
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note } });
    const sent = allPushes();
    assert.deepEqual(sent.map((m) => m.to).sort(), [token(30), token(31)]);
    assert.match(sent[0].title, /verification status/i);
    assert.equal(sent[0].body, "", "no staff text in a push about a decision");
    assert.equal(sent[0].data.type, "verification");
    assert.equal(sent[0].data.link, "/dashboard/");
    assert.ok(sent[0].data.notificationId);
    assert.ok(!JSON.stringify(sent).includes(note));

    // Switched off by the owner: nothing more is pushed, but the in-app notification is still made.
    assert.equal((await call("PATCH", "/api/account/notification-settings", { cookie: o.cookie, body: { push: false } })).json.settings.push, false);
    pushes.batches = [];
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Suspended", note: "x" } });
    assert.equal(allPushes().length, 0);
    assert.ok((await call("GET", "/api/notifications", { cookie: o.cookie, origin: null })).json.items.some((x) => /Suspended/.test(x.title)));
  });

  it("forgets a phone that the push service says no longer exists, and survives the service failing", async () => {
    const o = await owner();
    await register(o, token(40));
    pushes.invalid = [token(40)];
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Pending Verification", note: "x" } });
    assert.equal(await Device.countDocuments({ token: token(40) }), 0);

    await register(o, token(41));
    setPushSender({ enabled: true, async send() { throw new Error("service down"); } });
    const res = await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "y" } });
    assert.equal(res.status, 200, "the action still works");
  });

  it("tells phones about a new opportunity, but does not email it", async () => {
    const o = await owner({}, { state: "Edo" });
    await register(o, token(50));
    mails.sent = []; // the sign-up confirmation email is not what is being tested
    const created = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Edo Grant", provider: "NMREP", type: "Grant", description: "x", criteria: [{ key: "state", level: "required", values: ["Edo"] }] } });
    await call("PATCH", `/api/admin/opportunities/${created.json.opportunity.id}`, { cookie: admin, body: { status: "Open" } });
    const got = allPushes().find((m) => m.to === token(50));
    assert.ok(got);
    assert.equal(got.title, "New opportunity: Edo Grant");
    assert.equal(sentTo(o.email).length, 0);
  });
});

describe("notification settings and the unsubscribe link", () => {
  it("shows and changes what is also sent by email and push", async () => {
    const o = await owner();
    assert.deepEqual((await call("GET", "/api/account/notification-settings", { cookie: o.cookie, origin: null })).json.settings, { email: true, push: true });
    const res = await call("PATCH", "/api/account/notification-settings", { cookie: o.cookie, body: { email: false } });
    assert.deepEqual(res.json.settings, { email: false, push: true });
    assert.equal((await call("PATCH", "/api/account/notification-settings", { cookie: o.cookie, body: {} })).status, 422);
    assert.equal((await call("PATCH", "/api/account/notification-settings", { cookie: o.cookie, body: { email: "no" } })).status, 422);

    mails.sent = [];
    await call("POST", `/api/admin/businesses/${o.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "x" } });
    assert.equal(sentTo(o.email).length, 0, "an owner who turned email off is not emailed");
  });

  it("every notification email carries a link that switches those emails off for that account only", async () => {
    const a = await owner();
    const b = await owner();
    await call("POST", `/api/admin/businesses/${a.businessId}/status`, { cookie: admin, body: { status: "Verified", note: "x" } });
    const mail = sentTo(a.email).find((m) => /verification status/i.test(m.subject));
    const link = /https:\/\/nmrep\.test\/unsubscribe\/#token=([A-Za-z0-9._-]+)/.exec(mail.text);
    assert.ok(link, "the plain text has the link");
    assert.ok(mail.html.includes(`/unsubscribe/#token=${link[1]}`));

    assert.equal((await call("POST", "/api/auth/unsubscribe", { body: { token: "nonsense" } })).status, 400);
    assert.equal((await call("POST", "/api/auth/unsubscribe", { body: { token: link[1].replace(/.$/, link[1].endsWith("a") ? "b" : "a") } })).status, 400, "a changed token is refused");
    assert.equal((await call("POST", "/api/auth/unsubscribe", { body: { token: link[1] } })).status, 200);
    assert.equal((await User.findById(a.userId)).emailNotifications, false);
    assert.equal((await User.findById(b.userId)).emailNotifications, true, "nobody else is affected");
  });
});

describe("broadcasts and reminders also go out by email and push", () => {
  it("a broadcast is emailed with its text and the unsubscribe link, pushed to phones, and skips those who opted out", async () => {
    const yes = await owner({}, { state: "Benue" });
    const no = await owner({}, { state: "Benue" });
    const revoked = await owner({}, { state: "Benue" });
    await register(yes, token(60));
    await User.updateOne({ _id: no.userId }, { $set: { emailNotifications: false } });
    await call("PATCH", `/api/admin/businesses/${revoked.businessId}/account`, { cookie: admin, body: { active: false, reason: "test" } });

    const sent = await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "Benue workshop", body: "Free on Friday.", link: "/dashboard/training/", audience: { states: ["Benue"] } } });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    await flushBroadcasts();
    await mailer.flush();

    const mail = sentTo(yes.email).find((m) => m.subject === "Benue workshop");
    assert.ok(mail);
    assert.match(mail.text, /Free on Friday\./);
    assert.match(mail.text, /\/unsubscribe\/#token=/);
    assert.match(mail.text, /https:\/\/nmrep\.test\/dashboard\/training\//);
    assert.equal(sentTo(no.email).filter((m) => m.subject === "Benue workshop").length, 0);
    assert.equal(sentTo(revoked.email).filter((m) => m.subject === "Benue workshop").length, 0);

    const phone = allPushes().find((m) => m.to === token(60));
    assert.equal(phone.title, "Benue workshop");
    assert.equal(phone.body, "Free on Friday.");
    assert.equal(phone.data.type, "announcement");

    const row = await Broadcast.findById(sent.json.broadcast.id);
    assert.equal(row.emailsQueued, 1);
    assert.equal(row.pushesSent, 1);
    assert.equal(row.sendEmail, true);
  });

  it("can be sent without email", async () => {
    const o = await owner({}, { state: "Nasarawa" });
    const sent = await call("POST", "/api/admin/broadcasts", { cookie: admin, body: { title: "App only", sendEmail: false, audience: { states: ["Nasarawa"] } } });
    assert.equal(sent.status, 201);
    await flushBroadcasts();
    await mailer.flush();
    assert.equal(sentTo(o.email).filter((m) => m.subject === "App only").length, 0);
    assert.ok((await call("GET", "/api/notifications", { cookie: o.cookie, origin: null })).json.items.some((x) => x.title === "App only"));
  });

  it("deadline reminders are emailed and pushed, once", async () => {
    const o = await owner({}, { state: "Taraba" });
    await register(o, token(70));
    const created = await call("POST", "/api/admin/opportunities", { cookie: admin, body: { title: "Taraba Support", provider: "NMREP", type: "Support", description: "x", criteria: [{ key: "state", level: "required", values: ["Taraba"] }] } });
    const id = created.json.opportunity.id;
    await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Open" } });
    await Opportunity.updateOne({ _id: id }, { $set: { deadline: new Date(Date.now() + 2.5 * 86400000) } });
    mails.sent = [];
    pushes.batches = [];

    assert.ok((await runDeadlineReminders(new Date())) >= 1);
    await mailer.flush();
    const mail = sentTo(o.email).find((m) => /closes in 3 days/.test(m.subject));
    assert.ok(mail);
    assert.match(mail.text, /Eligible|eligible/);
    assert.match(mail.text, /Stop these emails/);
    assert.ok(allPushes().some((m) => m.to === token(70) && /closes in 3 days/.test(m.title)));

    await runDeadlineReminders(new Date());
    await mailer.flush();
    assert.equal(sentTo(o.email).filter((m) => /closes in 3 days/.test(m.subject)).length, 1);
  });
});
