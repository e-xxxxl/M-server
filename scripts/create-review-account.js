// Creates (or resets) the account a store reviewer uses to sign in to the app, in the database your backend/.env points to.
// Run it on the server, where the live .env is:
//
//     npm run review-account
//     npm run review-account -- --email reviewer@example.com --phone 08000000002 --years 2
//     npm run review-account -- --reset-password        (new password for the existing account, more paid time)
//     npm run review-account -- --verified              (also mark the sample business Verified, with an ID)
//     npm run review-account -- --check                 (changes NOTHING: checks the account is ready for a reviewer)
//     npm run review-account -- --check --test-password (the same, and asks you to type the password to prove it works)
//
// The password is made by the script, printed ONCE in this terminal and stored only as a hash. Copy it into the store's
// "App access" instructions from here. Do not paste it into chat or email.
//
// The account is a normal business owner account with its email confirmed and the registration fee paid for --years
// (default 2), so the reviewer is never sent to the payment page. It is a real record: a super admin can delete it
// from the admin portal (Businesses, then Permanent delete) once the review is over.
import "dotenv/config";
import mongoose from "mongoose";
import { loadConfig } from "../src/config.js";
import readline from "node:readline";
import { createReviewAccount, inspectReviewAccount } from "../src/lib/review-account.js";
import { emailSchema, phoneSchema } from "../src/schemas.js";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const email = emailSchema.safeParse(value("email", "playstore.review@nmrep.org"));
const phone = phoneSchema.safeParse(value("phone", "+2348000000001"));
const years = Number(value("years", "2"));
if (!email.success || !phone.success || !Number.isInteger(years) || years < 1 || years > 10) {
  console.error("Check the values: --email must be an email address, --phone a phone number, --years a whole number from 1 to 10.");
  process.exit(1);
}

const config = loadConfig();
if (!config.mongodbUri) {
  console.error("MONGODB_URI is not set. Run this where the backend .env is.");
  process.exit(1);
}
mongoose.set("sanitizeFilter", true);
try {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
} catch (err) {
  console.error("Could not connect to MongoDB:", err?.name);
  process.exit(1);
}

/** Reads a line without showing it as you type. */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

if (has("check")) {
  try {
    const password = has("test-password") ? await askHidden("Type the review password to test it (not shown): ") : "";
    const results = await inspectReviewAccount(config, { email: email.data, password });
    for (const r of results) console.log(`  ${r.ok === true ? "OK      " : r.ok === false ? "PROBLEM " : "INFO    "} ${r.label}${r.detail ? ": " + r.detail : ""}`);
    const problems = results.filter((r) => r.ok === false).length;
    console.log("");
    console.log(problems === 0 ? "Everything the reviewer needs is in place." : `${problems} problem(s) above need fixing before you submit.`);
    process.exitCode = problems === 0 ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
  process.exit(process.exitCode ?? 0);
}

try {
  const result = await createReviewAccount(config, { email: email.data, phone: phone.data, years, resetPassword: has("reset-password"), verified: has("verified") });
  const until = result.paidUntil.toISOString().slice(0, 10);
  console.log(result.created ? "Review account created." : "Review account updated with a new password.");
  console.log("");
  console.log("  Sign in with:  " + result.email + "   (or the phone number " + result.phone + ")");
  console.log("  Password:      " + result.password);
  console.log("  Paid until:    " + until);
  console.log("");
  console.log("This password is not stored anywhere readable and will not be shown again. Copy it now.");
  if (result.created) console.log("Run with --reset-password if you lose it.");
} catch (err) {
  if (err?.code === "exists") console.error(`An account with ${email.data} already exists. Nothing was changed. Use --reset-password to give it a new password.`);
  else if (err?.code === "not_owner") console.error("That email belongs to a staff account, not a business owner. Nothing was changed.");
  else if (err?.code === 11000) console.error("That phone number or email is already used by another account. Nothing was changed. Try --phone with a different number.");
  else console.error("The account could not be created:", err?.name ?? "error");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
