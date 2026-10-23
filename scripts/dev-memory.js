// Runs the API against a temporary in-memory MongoDB, so you can try everything without
// Atlas. Data is lost when you stop it. Usage: npm run dev:memory
//
// To try the automated verification screens (NIN, BVN, CAC, TIN) without a Prembly account or any cost, start it with
// STAND_IN_VERIFICATION=true. A stand-in answers instead of Prembly, by these rules (never used in production):
//   NIN or BVN ending in 0: not found. Ending in 1: a record in a different name. Any other: a record in the name
//   STAND_IN_NAME (default "Ada Obi"), with the phone 08012345678.
//   CAC number ending in 0: not found. Ending in 1: a struck-off company. Any other: an active company with the business name.
//   TIN ending in 0: not found. Any other: a taxpayer named STAND_IN_NAME.
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
// A smaller MongoDB for the temporary test database than the library default (it downloads once).
process.env.MONGOMS_VERSION ??= "6.0.19";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureDocumentStorage } from "../src/lib/document-storage.js";
import { configureMailer } from "../src/lib/mailer.js";
import { configurePrembly, createPrembly, setPrembly } from "../src/lib/prembly.js";
import { hashPassword } from "../src/lib/crypto.js";
import { newTemporaryPassword } from "../src/lib/codes.js";
import { User } from "../src/models/User.js";

const standIn = process.env.STAND_IN_VERIFICATION === "true";
if (standIn && process.env.NODE_ENV === "production") {
  console.error("STAND_IN_VERIFICATION must never be used in production.");
  process.exit(1);
}

const config = loadConfig({
  ...process.env,
  // The document wallet on a throwaway key and folder, so uploads can be tried locally. Both disappear with the process.
  DOCUMENT_ENCRYPTION_KEY: process.env.DOCUMENT_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString("base64"),
  DOCUMENT_STORAGE_DIR: process.env.DOCUMENT_STORAGE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-dev-docs-")),
  ...(standIn ? { PREMBLY_API_KEY: "stand-in", VERIFICATION_HASH_KEY: "stand-in-".repeat(5) } : {}),
  NODE_ENV: "development",
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3100",
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ?? "10",
});

configureMailer(config); // prints emails to this console unless RESEND_API_KEY is set
configurePrembly(config);
configureDocumentStorage(config);
if (standIn) {
  const name = (process.env.STAND_IN_NAME ?? "Ada Obi").trim();
  const [first, ...rest] = name.split(/\s+/);
  const answer = (path, body) => {
    const n = String(body.number ?? body.rc_number ?? "");
    const last = n.slice(-1);
    if (last === "0") return { status: 400, json: {} };
    const hit = (data) => ({ status: 200, json: { status: true, detail: "Verification Successful", response_code: "00", data, verification: { reference: "stand-in" } } });
    if (path.endsWith("vnin-basic")) return hit(last === "1" ? { firstname: "Demo", surname: "Stranger", telephoneno: "08099999999" } : { firstname: first, surname: rest.join(" "), telephoneno: "08012345678" });
    if (path.endsWith("bvn_validation")) return hit(last === "1" ? { firstName: "Demo", lastName: "Stranger", phoneNumber: "08099999999" } : { firstName: first, lastName: rest.join(" "), phoneNumber: "08012345678" });
    if (path.endsWith("cac/basic")) return hit({ company_name: `${body.company_name ?? "Demo Company"} LIMITED`, company_status: last === "1" ? "Inactive" : "Active" });
    return hit({ taxpayer_name: name });
  };
  const fetchImpl = async (url, init) => {
    const r = answer(new URL(url).pathname, JSON.parse(init.body));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  };
  setPrembly(createPrembly(config.verification, { fetchImpl }));
  console.log(`Verification stand-in is ON (records are in the name "${name}"). Numbers ending in 0 are not found, ending in 1 do not match.`);
}
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 90_000 } });
await mongoose.connect(mongod.getUri("nmrep"));
console.log("In-memory MongoDB started. Data will be lost when this stops.");

// A throwaway super admin so the admin portal can be tried at once. The password is random, shown
// only here, and the account disappears with the temporary database.
const demoEmail = "super.admin@nmrep.test";
const demoPassword = newTemporaryPassword();
await User.create({
  fullName: "Demo Super Admin",
  email: demoEmail,
  phone: "+234 800 000 0000",
  passwordHash: await hashPassword(demoPassword, config.bcryptRounds),
  role: "super_admin",
});
console.log(`Demo super admin for the admin portal: ${demoEmail} / ${demoPassword}`);

const server = createApp(config).listen(config.port, () => {
  console.log(`NMREP API (in-memory database) on http://localhost:${config.port}. Allowed origins: ${config.corsOrigins.join(", ")}`);
});

async function stop() {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
