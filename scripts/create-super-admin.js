// Creates the first super admin account. Run it once on a computer that has your backend/.env:
//
//     npm run create-super-admin
//
// It asks for a name, email, phone and password (the password is not shown as you type).
// There is deliberately no way to do this from the website: a super admin can only be created
// by someone who controls the server. Later admins are created by a super admin in the portal.
//
// For automation you can instead set SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PHONE and
// SUPER_ADMIN_PASSWORD in the environment. That leaves the password in your shell history or
// process list, so prefer the prompts.
import "dotenv/config";
import readline from "node:readline/promises";
import mongoose from "mongoose";
import { hashPassword } from "../src/lib/crypto.js";
import { loadConfig } from "../src/config.js";
import { User } from "../src/models/User.js";
import { emailSchema, passwordSchema, phoneSchema } from "../src/schemas.js";

const config = loadConfig();
if (!config.mongodbUri) {
  console.error("MONGODB_URI is not set. Copy backend/.env.example to backend/.env and add it first.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** Reads a line without echoing it, when running in a terminal. */
function askHidden(question) {
  if (!process.stdin.isTTY) return rl.question(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function ask(label, fromEnv, parse, { hidden = false } = {}) {
  for (;;) {
    const raw = fromEnv ?? (hidden ? await askHidden(`${label}: `) : await rl.question(`${label}: `));
    const result = parse.safeParse(raw);
    if (result.success) return result.data;
    console.error(`  ${result.error.issues[0].message}`);
    if (fromEnv) process.exit(1); // do not loop forever on a bad value from the environment
  }
}

const { z } = await import("zod");
const nameSchema = z.string().trim().min(1, "Enter a name.").max(100, "Use 100 characters or fewer.");

const fullName = await ask("Full name", process.env.SUPER_ADMIN_NAME, nameSchema);
const email = await ask("Email address", process.env.SUPER_ADMIN_EMAIL, emailSchema);
const phone = await ask("Phone number", process.env.SUPER_ADMIN_PHONE, phoneSchema);

mongoose.set("sanitizeFilter", true);
try {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
} catch (err) {
  console.error("Could not connect to MongoDB:", err?.name, String(err?.message ?? "").replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exit(1);
}

if (await User.exists({ email })) {
  console.error(`An account with ${email} already exists. Nothing was changed.`);
  await mongoose.disconnect();
  process.exit(1);
}

const password = await ask("Password (8 or more characters, with a letter and a number)", process.env.SUPER_ADMIN_PASSWORD, passwordSchema, { hidden: true });
if (!process.env.SUPER_ADMIN_PASSWORD) {
  const again = await askHidden("Repeat password: ");
  if (again !== password) {
    console.error("The passwords do not match. Nothing was changed.");
    await mongoose.disconnect();
    process.exit(1);
  }
}

await User.create({
  fullName,
  email,
  phone,
  passwordHash: await hashPassword(password, config.bcryptRounds),
  role: "super_admin",
  mustChangePassword: false, // they chose this password themselves
});

console.log(`Super admin created for ${email}. Log in on the website, then open the admin portal.`);
rl.close();
await mongoose.disconnect();
