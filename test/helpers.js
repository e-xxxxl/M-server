import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
// A smaller MongoDB for the temporary test database than the library default (it downloads once).
process.env.MONGOMS_VERSION ??= "6.0.19";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export const ORIGIN = "http://localhost:3000";

export async function startTestServer(overrides = {}) {
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } });
  mongoose.set("sanitizeFilter", true);
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongod.getUri("nmrep_test"));

  const config = loadConfig({
    NODE_ENV: "test",
    CORS_ORIGINS: ORIGIN,
    BCRYPT_ROUNDS: "4", // fast hashing for tests only
    RATE_LIMIT_LOGIN: "1000",
    RATE_LIMIT_REGISTER: "1000",
    RATE_LIMIT_GENERAL: "10000",
    ...overrides,
  });
  const server = createApp(config, { log: false }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    config,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

/** Another app instance on the already-connected test database, with different settings (for example tighter rate limits). */
export async function startExtraApp(overrides = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    CORS_ORIGINS: ORIGIN,
    BCRYPT_ROUNDS: "4",
    RATE_LIMIT_GENERAL: "10000",
    ...overrides,
  });
  const server = createApp(config, { log: false }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(resolve)) };
}

/** Calls the API like a browser would: with an Origin header and, if given, a session cookie. */
export function client(base) {
  return async function call(method, path, { body, cookie, origin = ORIGIN, raw } = {}) {
    const headers = {};
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const session = setCookies.find((c) => c.startsWith("nmrep_session="));
    return {
      status: res.status,
      json,
      text,
      headers: res.headers,
      setCookie: session ?? null,
      cookie: session ? session.split(";")[0] : null,
    };
  };
}

let counter = 0;

export function registrationBody(overrides = {}) {
  counter += 1;
  return {
    account: {
      fullName: "Ada Obi",
      email: `ada${counter}@example.com`,
      phone: "+234 801 234 5678",
      password: "Secret123",
      ...overrides.account,
    },
    business: {
      businessName: "Obi Fabrics",
      tradingName: "",
      businessType: "Private limited company",
      sector: "Fashion and textiles",
      industry: "Tailoring",
      yearEstablished: "2019",
      cacNumber: "",
      tin: "",
      state: "Lagos",
      lga: "Ikeja",
      city: "Ikeja",
      address: "12 Allen Avenue",
      ownerName: "Ada Obi",
      ownerRole: "Owner and director",
      ownershipStructure: "Sole owner",
      employees: "4",
      branches: "",
      annualRevenue: "5 to 25 million naira",
      bankName: "",
      existingLoans: "No",
      fundingNeeds: "",
      website: "",
      facebook: "",
      instagram: "",
      x: "",
      tiktok: "",
      ...overrides.business,
    },
    acceptedTerms: true,
    confirmedAccurate: true,
    ...overrides.top,
  };
}
