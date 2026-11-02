import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setPaystack } from "../src/lib/paystack.js";
import { Product } from "../src/models/Product.js";
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

async function owner() {
  const res = await call("POST", "/api/auth/register", { body: registrationBody() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}
const add = (o, body) => call("POST", "/api/products", { cookie: o.cookie, body });
const sample = (over = {}) => ({ kind: "Product", name: "Plastic bucket", category: "Household", description: "A 20 litre bucket with a lid.", unitPrice: 1500, priceUnit: "per bucket", capacity: "2000 a month", exportReady: true, ...over });

describe("products and services", () => {
  it("an owner adds, lists, changes and removes a product", async () => {
    const o = await owner();
    const created = await add(o, sample());
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const p = created.json.product;
    assert.equal(p.name, "Plastic bucket");
    assert.equal(p.unitPrice, 1500);
    assert.equal(p.exportReady, true);
    assert.ok(p.id);
    assert.equal(p.owner, undefined, "the owner and business ids are not returned");
    assert.equal(p.business, undefined);

    const list = await call("GET", "/api/products", { cookie: o.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.total, 1);
    assert.equal(list.json.limit, 30);
    assert.deepEqual(list.json.kinds, ["Product", "Service"]);

    const changed = await call("PATCH", `/api/products/${p.id}`, { cookie: o.cookie, body: { unitPrice: 1800, exportReady: false } });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.product.unitPrice, 1800);
    assert.equal(changed.json.product.exportReady, false);
    assert.equal(changed.json.product.name, "Plastic bucket", "what was not sent is not changed");
    assert.equal(changed.json.product.capacity, "2000 a month");

    const removed = await call("DELETE", `/api/products/${p.id}`, { cookie: o.cookie });
    assert.equal(removed.status, 204);
    assert.equal((await call("GET", "/api/products", { cookie: o.cookie })).json.total, 0);
  });

  it("a price is optional: empty means not given, and clearing a price works", async () => {
    const o = await owner();
    const none = await add(o, { kind: "Service", name: "Tailoring" });
    assert.equal(none.status, 201, JSON.stringify(none.json));
    assert.equal(none.json.product.unitPrice, null);
    assert.equal(none.json.product.exportReady, false);
    const blank = await add(o, sample({ unitPrice: "" }));
    assert.equal(blank.json.product.unitPrice, null);
    const text = await add(o, sample({ unitPrice: "2500.50" }));
    assert.equal(text.json.product.unitPrice, 2500.5);

    const cleared = await call("PATCH", `/api/products/${text.json.product.id}`, { cookie: o.cookie, body: { unitPrice: "" } });
    assert.equal(cleared.json.product.unitPrice, null);
    const kept = await call("PATCH", `/api/products/${text.json.product.id}`, { cookie: o.cookie, body: { name: "Renamed" } });
    assert.equal(kept.json.product.unitPrice, null, "a change that does not mention the price leaves it as it was");
  });

  it("rejects bad input with field messages and unknown fields", async () => {
    const o = await owner();
    for (const [body, field] of [
      [sample({ name: "" }), "name"],
      [sample({ kind: "Gadget" }), "kind"],
      [sample({ unitPrice: -5 }), "unitPrice"],
      [sample({ unitPrice: "cheap" }), "unitPrice"],
      [sample({ description: "x".repeat(501) }), "description"],
      [sample({ exportReady: "yes" }), "exportReady"],
    ]) {
      const res = await add(o, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.ok(res.json.error.fields[field], `${field} has a message`);
    }
    assert.equal((await add(o, { ...sample(), owner: "someone" })).status, 422, "an unknown field is refused");
    const created = await add(o, sample());
    assert.equal((await call("PATCH", `/api/products/${created.json.product.id}`, { cookie: o.cookie, body: {} })).status, 422, "an empty change is refused");
  });

  it("keeps products private to their owner", async () => {
    const a = await owner();
    const b = await owner();
    const mine = await add(a, sample());
    const id = mine.json.product.id;
    assert.equal((await call("GET", "/api/products", { cookie: b.cookie })).json.total, 0);
    assert.equal((await call("PATCH", `/api/products/${id}`, { cookie: b.cookie, body: { name: "Mine now" } })).status, 404);
    assert.equal((await call("DELETE", `/api/products/${id}`, { cookie: b.cookie })).status, 404);
    assert.equal((await call("DELETE", "/api/products/not-an-id", { cookie: b.cookie })).status, 404);
    assert.equal((await call("GET", "/api/products", {})).status, 401);
    assert.equal((await call("GET", "/api/products", { cookie: admin })).status, 403, "staff accounts use the admin pages instead");
  });

  it("stops at 30 products and services", async () => {
    const o = await owner();
    await Product.insertMany(Array.from({ length: 30 }, (_, i) => ({ owner: o.id, business: o.businessId, kind: "Product", name: `Item ${i}` })));
    const res = await add(o, sample());
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, "product_limit");
  });

  it("shows in the health profile, in the admin business view, and goes with the account", async () => {
    const o = await owner();
    const before = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    const itemOf = (hp) => hp.areas.find((a) => a.id === "information").items.find((i) => i.id === "products");
    assert.equal(itemOf(before).done, false);
    await add(o, sample());
    await add(o, sample({ name: "Basin", kind: "Product" }));
    const after = (await call("GET", "/api/health-profile", { cookie: o.cookie })).json;
    assert.equal(itemOf(after).done, true);
    assert.equal(itemOf(after).detail, "2 listed");

    const detail = await call("GET", `/api/admin/businesses/${o.businessId}`, { cookie: admin });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.products.length, 2);
    assert.equal(detail.json.products[0].owner, undefined);

    const del = await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Secret123" } });
    assert.equal(del.status, 204, JSON.stringify(del.json));
    assert.equal(await Product.countDocuments({ owner: o.id }), 0, "deleting the account deletes the products");
  });

  it("is blocked while the registration fee is unpaid", async () => {
    setPaystack(undefined);
    const fee = await (await import("./helpers.js")).startExtraApp({ PAYSTACK_SECRET_KEY: "sk_test_not_real_for_tests" });
    try {
      const c = client(fee.base);
      const res = await c("POST", "/api/auth/register", { body: registrationBody() });
      const blocked = await c("GET", "/api/products", { cookie: res.cookie });
      assert.equal(blocked.status, 402);
      assert.equal(blocked.json.error.code, "payment_required");
    } finally {
      await fee.stop();
    }
  });
});
