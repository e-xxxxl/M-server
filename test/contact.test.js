import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setMailer } from "../src/lib/mailer.js";
import { ContactMessage } from "../src/models/ContactMessage.js";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// The public contact form: kept for staff, copied to the NMREP inbox, with a hidden field that catches bots.

let ctx;
let call;
let admin;
const sent = [];
const body = (extra = {}) => ({ name: "Ada Obi", email: "ada@example.com", phone: "", subject: "A question", message: "How do I renew my registration?", website: "", ...extra });

before(async () => {
  ctx = await startTestServer();
  call = client(ctx.base);
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
  setMailer({ enabled: true, send: async (m) => (sent.push(m), { ok: true }) });
});
after(async () => {
  await ctx.stop();
});

describe("the contact form", () => {
  it("keeps the message, copies it to the NMREP inbox, and needs no sign in", async () => {
    sent.length = 0;
    const res = await call("POST", "/api/contact", { body: body() });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json, { received: true });
    assert.equal(await ContactMessage.countDocuments({ subject: "A question" }), 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "contact@nmrep.org");
    assert.match(sent[0].text, /How do I renew/);
  });

  it("drops a message whose hidden field is filled, without saying so", async () => {
    sent.length = 0;
    const before = await ContactMessage.countDocuments();
    const res = await call("POST", "/api/contact", { body: body({ website: "http://spam.example" }) });
    assert.equal(res.status, 201);
    assert.equal(await ContactMessage.countDocuments(), before);
    assert.equal(sent.length, 0);
  });

  it("checks every field and refuses anything unknown", async () => {
    for (const extra of [{ name: "A" }, { email: "nope" }, { subject: "ab" }, { message: "short" }, { phone: "abc" }, { message: "x".repeat(2001) }, { nin: "12345678901" }]) {
      const res = await call("POST", "/api/contact", { body: body(extra) });
      assert.equal(res.status, 422, JSON.stringify(extra).slice(0, 60));
    }
  });

  it("is listed for staff only, and can be marked answered", async () => {
    assert.equal((await call("GET", "/api/admin/contact-messages")).status, 401);
    const owner = await call("POST", "/api/auth/register", { body: registrationBody() });
    assert.equal((await call("GET", "/api/admin/contact-messages", { cookie: owner.cookie })).status, 403);

    const list = await call("GET", "/api/admin/contact-messages", { cookie: admin });
    assert.equal(list.status, 200);
    const item = list.json.items.find((i) => i.subject === "A question");
    assert.equal(item.handled, false);
    assert.ok(list.json.open >= 1);
    const done = await call("POST", `/api/admin/contact-messages/${item.id}/handled`, { cookie: admin, body: {} });
    assert.equal(done.json.item.handled, true);
    const open = await call("GET", "/api/admin/contact-messages?handled=false", { cookie: admin });
    assert.ok(!open.json.items.some((i) => i.id === item.id));
  });
});
