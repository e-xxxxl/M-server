import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { client, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

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

async function owner(business = {}) {
  const res = await call("POST", "/api/auth/register", { body: registrationBody({ business }) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, businessId: res.json.business.id, userId: res.json.user.id };
}

async function makeOpportunity(extra = {}) {
  const res = await call("POST", "/api/admin/opportunities", {
    cookie: admin,
    body: { title: "Depth programme", provider: "Example Foundation", type: "Grant", description: "A programme.", ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const id = res.json.opportunity.id;
  const open = await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { status: "Open" } });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  return id;
}

/** A wallet record without a real file: applying only looks at who owns it and what kind it is. */
async function addDocument(o, kind) {
  const { Document } = await import("../src/models/Document.js");
  const d = await Document.create({
    owner: o.userId,
    business: o.businessId,
    kind,
    title: `${kind} copy`,
    mime: "application/pdf",
    size: 1000,
    sha256: crypto.randomBytes(32).toString("hex"),
    storageKey: crypto.randomBytes(16).toString("hex"),
    iv: "iv",
    tag: "tag",
  });
  return String(d._id);
}

const apply = (o, id, body) => call("POST", "/api/applications", { cookie: o.cookie, body: { opportunityId: id, ...body } });

describe("application questions", () => {
  it("an opportunity asks up to eight questions, each with a stable id the owner answers", async () => {
    const o = await owner();
    const id = await makeOpportunity({
      questions: [
        { text: "How will you use the grant?", required: true },
        { text: "Anything else we should know?" },
      ],
    });
    const detail = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null })).json.opportunity;
    assert.equal(detail.questions.length, 2);
    assert.deepEqual(detail.questions.map((q) => [q.text, q.required]), [["How will you use the grant?", true], ["Anything else we should know?", false]]);
    assert.match(detail.questions[0].id, /^[a-f0-9]{24}$/);

    // A draft may be partly answered.
    const draft = await apply(o, id, { message: "", answers: [{ questionId: detail.questions[1].id, answer: "We employ twelve people." }] });
    assert.equal(draft.status, 201, JSON.stringify(draft.json));
    assert.deepEqual(draft.json.application.answers.map((a) => a.answer), ["We employ twelve people."]);

    // A submission needs every required question answered, and the error names the question's position.
    const missing = await apply(o, id, { submit: true, consent: { summary: true }, answers: [{ questionId: detail.questions[1].id, answer: "Only this one" }] });
    assert.equal(missing.status, 422);
    assert.equal(missing.json.error.fields["answers.0"], "Answer this question.");

    // Leaving the answers out keeps the saved ones, so the required one is still missing.
    const kept = await apply(o, id, { submit: true, consent: { summary: true } });
    assert.equal(kept.status, 422);
    assert.ok(kept.json.error.fields["answers.0"]);

    const sent = await apply(o, id, {
      submit: true,
      consent: { summary: true },
      answers: [{ questionId: detail.questions[0].id, answer: "To buy two sewing machines." }, { questionId: detail.questions[1].id, answer: "" }],
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(sent.json.application.status, "Submitted");
    assert.deepEqual(sent.json.application.answers.map((a) => [a.question, a.answer]), [["How will you use the grant?", "To buy two sewing machines."]]);

    // A reviewer sees the answers with the application.
    const list = await call("GET", "/api/admin/applications", { cookie: admin, origin: null });
    const row = list.json.items.find((i) => i.id === sent.json.application.id);
    const review = await call("GET", `/api/admin/applications/${row.id}`, { cookie: admin, origin: null });
    assert.equal(review.json.application.answers[0].answer, "To buy two sewing machines.");
  });

  it("refuses an answer to a question the opportunity does not have, an answer that is too long, and too many questions", async () => {
    const o = await owner();
    const id = await makeOpportunity({ questions: [{ text: "One?" }] });
    const stranger = await apply(o, id, { answers: [{ questionId: "a".repeat(24), answer: "x" }] });
    assert.equal(stranger.status, 422);
    assert.ok(stranger.json.error.fields["answers.0.questionId"]);

    const detail = (await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null })).json.opportunity;
    const long = await apply(o, id, { answers: [{ questionId: detail.questions[0].id, answer: "x".repeat(501) }] });
    assert.equal(long.status, 422);

    const nine = await call("POST", "/api/admin/opportunities", {
      cookie: admin,
      body: { title: "Too many", provider: "X", type: "Grant", description: "d", questions: Array.from({ length: 9 }, (_, i) => ({ text: `Q${i}` })) },
    });
    assert.equal(nine.status, 422);
  });

  it("editing a question keeps its id, and an unknown id is refused", async () => {
    const id = await makeOpportunity({ questions: [{ text: "Original wording", required: true }] });
    const before = (await call("GET", `/api/admin/opportunities/${id}`, { cookie: admin, origin: null })).json.opportunity.questions[0];
    const edited = await call("PATCH", `/api/admin/opportunities/${id}`, {
      cookie: admin,
      body: { questions: [{ id: before.id, text: "New wording", required: false }, { text: "A second question" }] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.opportunity.questions[0].id, before.id);
    assert.equal(edited.json.opportunity.questions[0].text, "New wording");
    assert.notEqual(edited.json.opportunity.questions[1].id, before.id);

    const stranger = await call("PATCH", `/api/admin/opportunities/${id}`, { cookie: admin, body: { questions: [{ id: "b".repeat(24), text: "Ghost" }] } });
    assert.equal(stranger.status, 422);
    assert.ok(stranger.json.error.fields["questions.0.id"]);
  });
});

describe("required documents", () => {
  it("validates the kinds, and tells the owner which of them are already in the wallet", async () => {
    const bad = await call("POST", "/api/admin/opportunities", {
      cookie: admin,
      body: { title: "Bad", provider: "X", type: "Grant", description: "d", requiredDocuments: ["Other"] },
    });
    assert.equal(bad.status, 422, '"Other" cannot be required');

    const o = await owner();
    await addDocument(o, "CAC Certificate");
    const id = await makeOpportunity({ requiredDocuments: ["CAC Certificate", "Tax Clearance", "CAC Certificate"] });
    const res = await call("GET", `/api/opportunities/${id}`, { cookie: o.cookie, origin: null });
    assert.deepEqual(res.json.opportunity.requiredDocuments, ["CAC Certificate", "Tax Clearance"], "listed once each");
    assert.deepEqual(res.json.documentsNeeded, [{ kind: "CAC Certificate", inWallet: true }, { kind: "Tax Clearance", inWallet: false }]);
  });

  it("a submission must attach a document of every required kind, a draft need not", async () => {
    const o = await owner();
    const cac = await addDocument(o, "CAC Certificate");
    const tax = await addDocument(o, "Tax Clearance");
    const id = await makeOpportunity({ requiredDocuments: ["CAC Certificate", "Tax Clearance"] });

    assert.equal((await apply(o, id, { message: "draft" })).status, 201, "a draft needs no documents");

    const none = await apply(o, id, { submit: true, consent: { summary: true } });
    assert.equal(none.status, 422);
    assert.equal(none.json.error.code, "documents_required");
    assert.match(none.json.error.fields.documentIds, /CAC Certificate, Tax Clearance/);

    const one = await apply(o, id, { submit: true, consent: { summary: true, documents: true }, documentIds: [cac] });
    assert.equal(one.status, 422);
    assert.match(one.json.error.fields.documentIds, /Tax Clearance/);
    assert.ok(!one.json.error.fields.documentIds.includes("CAC Certificate"), "only the missing kind is named");

    const both = await apply(o, id, { submit: true, consent: { summary: true, documents: true }, documentIds: [cac, tax] });
    assert.equal(both.status, 201, JSON.stringify(both.json));
    assert.deepEqual(both.json.application.documents.sort(), [cac, tax].sort());
  });
});
