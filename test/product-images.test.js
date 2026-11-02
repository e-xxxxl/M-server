import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createDocumentStorage, setDocumentStorage } from "../src/lib/document-storage.js";
import { Product } from "../src/models/Product.js";
import { client, ORIGIN, registrationBody, startTestServer } from "./helpers.js";
import { createStaff, logIn } from "./staff-helpers.js";

// Product pictures: JPEG or PNG only (decided from the first bytes), up to 3 per product and 3 MB each, stored encrypted
// in the same private folder as the document wallet, and seen only by the owner and by NMREP staff.

let ctx;
let call;
let admin;
let dir;
const key = crypto.randomBytes(32).toString("base64");

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(60)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(60)]);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-product-images-"));
  ctx = await startTestServer();
  call = client(ctx.base);
  setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
  const a = await createStaff({ role: "admin" });
  admin = (await logIn(call, a.email, a.password)).cookie;
});
after(async () => {
  setDocumentStorage(createDocumentStorage(null));
  await ctx.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner() {
  const res = await call("POST", "/api/auth/register", { body: registrationBody() });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { cookie: res.cookie, id: res.json.user.id, businessId: res.json.business.id };
}
async function product(o) {
  const res = await call("POST", "/api/products", { cookie: o.cookie, body: { kind: "Product", name: "Plastic bucket" } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.product.id;
}
async function addImage(o, productId, { bytes = png(), name = "photo.png", type = "image/png", fields = {} } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (bytes !== null) form.set("file", new Blob([bytes], { type }), name);
  const res = await fetch(`${ctx.base}/api/products/${productId}/images`, { method: "POST", headers: { Origin: ORIGIN, ...(o ? { Cookie: o.cookie } : {}) }, body: form });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
const fetchImage = (urlPath, cookie) => fetch(ctx.base + urlPath, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });
const filesOnDisk = () => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : (n += 1));
  };
  walk(dir);
  return n;
};

describe("product pictures", () => {
  it("adds a picture, shows only its facts, and gives the owner the same bytes back", async () => {
    const o = await owner();
    const id = await product(o);
    const bytes = png();
    const added = await addImage(o, id, { bytes });
    assert.equal(added.status, 201, added.text);
    const [image] = added.json.product.images;
    assert.deepEqual(Object.keys(image).sort(), ["id", "mime", "size"], "no storage details leave the server");
    assert.equal(image.mime, "image/png");
    assert.equal(image.size, bytes.length);
    assert.ok(!added.text.includes("storageKey") && !added.text.includes("iv"));

    const got = await fetchImage(`/api/products/${id}/images/${image.id}`, o.cookie);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.match(got.headers.get("content-disposition"), /^inline/);
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));

    const list = await call("GET", "/api/products", { cookie: o.cookie });
    assert.deepEqual(list.json.images, { available: true, maxPerProduct: 3, maxMb: 3, types: ["JPEG", "PNG"] });
    assert.equal(list.json.items[0].images.length, 1);
  });

  it("is stored encrypted: the file on disk is not the picture", async () => {
    const o = await owner();
    const id = await product(o);
    const bytes = png();
    await addImage(o, id, { bytes });
    const stored = await Product.findById(id);
    const file = path.join(dir, stored.images[0].storageKey.slice(0, 2), stored.images[0].storageKey);
    assert.ok(!fs.readFileSync(file).includes(bytes.subarray(0, 20)), "the bytes on disk are encrypted");
  });

  it("decides the type from the first bytes, and refuses anything else", async () => {
    const o = await owner();
    const id = await product(o);
    assert.equal((await addImage(o, id, { bytes: jpeg(), name: "photo.txt", type: "text/plain" })).status, 201, "a JPEG with a wrong name is still a JPEG");
    for (const bytes of [Buffer.from("%PDF-1.4\nnot a picture"), Buffer.from("<script>alert(1)</script>"), Buffer.from("GIF89a....")]) {
      const res = await addImage(o, id, { bytes, name: "photo.png", type: "image/png" });
      assert.equal(res.status, 422);
      assert.equal(res.json.error.code, "unsupported_file");
    }
    assert.equal((await addImage(o, id, { bytes: null })).status, 422, "no file");
    assert.equal((await addImage(o, id, { fields: { kind: "ID" } })).status, 422, "no other fields");
  });

  it("stops at 3 pictures, and at the size limit", async () => {
    const o = await owner();
    const id = await product(o);
    for (let i = 0; i < 3; i += 1) assert.equal((await addImage(o, id)).status, 201);
    const fourth = await addImage(o, id);
    assert.equal(fourth.status, 422);
    assert.equal(fourth.json.error.code, "image_limit");

    const id2 = await product(o);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024 + 10)]);
    const res = await addImage(o, id2, { bytes: big });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, "file_too_large");
  });

  it("never goes over 3 when uploads arrive at once", async () => {
    const o = await owner();
    const id = await product(o);
    const results = await Promise.all(Array.from({ length: 6 }, () => addImage(o, id)));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal((await Product.findById(id)).images.length, 3);
    assert.equal(results.filter((r) => r.status === 422).length, 3);
  });

  it("removes the file from the disk when a picture, a product or the account is deleted", async () => {
    const o = await owner();
    const id = await product(o);
    const before = filesOnDisk();
    const a = (await addImage(o, id)).json.product.images[0];
    await addImage(o, id);
    assert.equal(filesOnDisk(), before + 2);

    assert.equal((await call("DELETE", `/api/products/${id}/images/${a.id}`, { cookie: o.cookie })).status, 204);
    assert.equal(filesOnDisk(), before + 1);
    assert.equal((await fetchImage(`/api/products/${id}/images/${a.id}`, o.cookie)).status, 404);

    assert.equal((await call("DELETE", `/api/products/${id}`, { cookie: o.cookie })).status, 204);
    assert.equal(filesOnDisk(), before, "deleting the product deletes its pictures");

    const id2 = await product(o);
    await addImage(o, id2);
    assert.equal(filesOnDisk(), before + 1);
    assert.equal((await call("DELETE", "/api/account", { cookie: o.cookie, body: { password: "Secret123" } })).status, 204);
    assert.equal(filesOnDisk(), before, "deleting the account deletes the pictures");
  });

  it("is private: another owner, anonymous visitors and the wrong ids get nothing; staff can look", async () => {
    const a = await owner();
    const b = await owner();
    const id = await product(a);
    const image = (await addImage(a, id)).json.product.images[0];
    const path1 = `/api/products/${id}/images/${image.id}`;
    assert.equal((await fetchImage(path1, b.cookie)).status, 404);
    assert.equal((await fetchImage(path1, null)).status, 401);
    assert.equal((await fetchImage(`/api/products/${id}/images/not-an-id`, a.cookie)).status, 404);
    assert.equal((await addImage(b, id)).status, 404, "another owner cannot add to it");
    assert.equal((await call("DELETE", path1, { cookie: b.cookie })).status, 404);
    assert.equal((await addImage(null, id)).status, 401);

    const seen = await fetchImage(`/api/admin/businesses/${a.businessId}/products/${id}/images/${image.id}`, admin);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/png");
    assert.equal((await fetchImage(`/api/admin/businesses/${b.businessId}/products/${id}/images/${image.id}`, admin)).status, 404, "it has to be that business's product");
    assert.equal((await fetchImage(`/api/admin/businesses/${a.businessId}/products/${id}/images/${image.id}`, a.cookie)).status, 403, "owners use their own route");
    const detail = await call("GET", `/api/admin/businesses/${a.businessId}`, { cookie: admin });
    assert.equal(detail.json.products[0].images.length, 1);
    assert.equal(detail.json.products[0].images[0].storageKey, undefined);
  });

  it("is off, with a clear answer, when the private storage is not set up", async () => {
    const o = await owner();
    const id = await product(o);
    setDocumentStorage(createDocumentStorage(null));
    try {
      const res = await addImage(o, id);
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, "images_unavailable");
      assert.equal((await call("GET", "/api/products", { cookie: o.cookie })).json.images.available, false);
    } finally {
      setDocumentStorage(createDocumentStorage({ dir, encryptionKey: key }));
    }
  });
});
