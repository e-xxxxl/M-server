import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { client, registrationBody, startExtraApp, startTestServer } from "./helpers.js";

// Testing mode (ALLOW_TOKEN_AUTH): the site can work from another domain without cookies.
// It must be off by default, and must never weaken the normal cookie behaviour.

let ctx;
let off;
let on;
let callOff;
let callOn;
let tokenApp;

before(async () => {
  ctx = await startTestServer();
  callOff = client(ctx.base);
  tokenApp = await startExtraApp({ ALLOW_TOKEN_AUTH: "true" });
  callOn = client(tokenApp.base);
  off = callOff;
  on = callOn;
});
after(async () => {
  await tokenApp.stop();
  await ctx.stop();
});

const bearer = (base, path, token, method = "GET") =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:3000" } });

describe("token auth for testing", () => {
  it("is off by default: no token in responses and Bearer is refused", async () => {
    const body = registrationBody();
    const reg = await off("POST", "/api/auth/register", { body });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.token, undefined);
    assert.ok(reg.cookie, "the cookie still works");
    const login = await off("POST", "/api/auth/login", { body: { email: body.account.email, password: body.account.password } });
    assert.equal(login.json.token, undefined);
    // A real token from a cookie login is not accepted as a Bearer token while the mode is off.
    const token = login.cookie.split("=")[1];
    const res = await bearer(ctx.base, "/api/dashboard", token);
    assert.equal(res.status, 401);
  });

  it("when on: login and registration return a token that works without a cookie", async () => {
    const body = registrationBody();
    const reg = await on("POST", "/api/auth/register", { body });
    assert.equal(reg.status, 201);
    assert.match(reg.json.token, /^[A-Za-z0-9_-]{20,}$/);
    const dash = await bearer(tokenApp.base, "/api/dashboard", reg.json.token);
    assert.equal(dash.status, 200);

    // Logging in while presenting the old token replaces it, exactly as the cookie does.
    const loginRes = await fetch(tokenApp.base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", Authorization: `Bearer ${reg.json.token}` },
      body: JSON.stringify({ email: body.account.email, password: body.account.password }),
    });
    const login = { status: loginRes.status, json: await loginRes.json() };
    assert.equal(login.status, 200);
    assert.ok(login.json.token);
    assert.notEqual(login.json.token, reg.json.token, "a new token on every login");
    const old = await bearer(tokenApp.base, "/api/dashboard", reg.json.token);
    assert.equal(old.status, 401, "the old token stops working once replaced");
    const fresh = await bearer(tokenApp.base, "/api/dashboard", login.json.token);
    assert.equal(fresh.status, 200);
  });

  it("when on: a wrong or malformed token is refused and logout revokes the token", async () => {
    const body = registrationBody();
    const reg = await on("POST", "/api/auth/register", { body });
    for (const bad of ["nope", "a b", "x".repeat(300)]) {
      const res = await bearer(tokenApp.base, "/api/dashboard", bad);
      assert.equal(res.status, 401, bad.slice(0, 10));
    }
    const out = await bearer(tokenApp.base, "/api/auth/logout", reg.json.token, "POST");
    assert.equal(out.status, 204);
    const after = await bearer(tokenApp.base, "/api/dashboard", reg.json.token);
    assert.equal(after.status, 401);
  });

  it("when on: state-changing requests still need an allowed Origin", async () => {
    const body = registrationBody();
    const reg = await on("POST", "/api/auth/register", { body });
    const res = await fetch(tokenApp.base + "/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${reg.json.token}` } });
    assert.equal(res.status, 403);
  });

  it("the Authorization header is allowed by CORS", async () => {
    const res = await fetch(tokenApp.base + "/api/dashboard", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  });
});
