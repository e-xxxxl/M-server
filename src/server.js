import "dotenv/config";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { configureMailer } from "./lib/mailer.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureDocumentStorage } from "./lib/document-storage.js";
import { configurePrembly } from "./lib/prembly.js";
import { configurePaystack } from "./lib/paystack.js";
import { configurePush } from "./lib/push.js";
import { backfillPhoneKeys } from "./lib/phone.js";
import { startReminderScheduler } from "./lib/reminders.js";
import { verificationEnabled } from "./lib/verification.js";

const config = loadConfig();

if (!config.mongodbUri) {
  console.error(
    "MONGODB_URI is not set. Copy backend/.env.example to backend/.env and add your MongoDB connection string.",
  );
  process.exit(1);
}

// Defence in depth for database queries: treat any query operator found in user input as plain data.
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

try {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
} catch (err) {
  // Print the reason but never the connection string, which contains the database password.
  console.error("Could not connect to MongoDB:", err?.name, err?.message?.replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exit(1);
}
console.log("Connected to MongoDB.");

const mail = configureMailer(config);
if (!mail.enabled) {
  console.warn(
    config.isProd
      ? "WARNING: email is OFF (RESEND_API_KEY or EMAIL_FROM is not set). Password reset and confirmation emails will not be sent."
      : "Email is off (no RESEND_API_KEY). Emails are printed here instead of being sent.",
  );
}

configurePrembly(config);
configurePaystack(config);
configurePush(config);
if (config.payments.enabled) {
  console.log(`Registration fee is ON: N${config.payments.registrationFeeNaira} a year through Paystack.${config.payments.secretKey.startsWith("sk_test_") ? " (test key)" : ""}`);
  if (config.isProd && config.payments.secretKey.startsWith("sk_test_")) console.warn("WARNING: a Paystack TEST key is set in production. Real payments will not work.");
} else if (config.isProd) {
  console.warn("WARNING: the registration fee is OFF (PAYSTACK_SECRET_KEY is not set). Owners can use the platform without paying.");
}
if (!config.notifications.unsubscribeSecret) {
  console.warn("UNSUBSCRIBE_SECRET is not set: the Stop these emails links stop working whenever the server restarts. Set a long random value.");
}
const phoneKeys = await backfillPhoneKeys();
if (phoneKeys > 0) console.log(`Added a phone sign-in key to ${phoneKeys} existing account${phoneKeys === 1 ? "" : "s"}.`);
if (!configureDocumentStorage(config).enabled) {
  if (config.isProd) {
    console.warn("WARNING: the document wallet is OFF (DOCUMENT_ENCRYPTION_KEY is not set, or is not 32 bytes as base64). Owners will see \"Documents are not available right now\". Run npm run document-key and add the lines it prints to the server's settings.");
  } else {
    // On a development machine, try the wallet at once with a throwaway key and folder. Never done in production.
    configureDocumentStorage(
      { documents: { ...config.documents, encryptionKey: crypto.randomBytes(32).toString("base64"), dir: fs.mkdtempSync(path.join(os.tmpdir(), "nmrep-dev-docs-")) } },
      { root: "/" },
    );
    console.warn("The document wallet is on with a TEMPORARY key and folder (development only). Files are lost when this stops. Run npm run document-key and add the lines to backend/.env to keep them.");
  }
}
if (!verificationEnabled(config)) {
  console.warn("Automated verification checks are off (PREMBLY_API_KEY or VERIFICATION_HASH_KEY is not set, or the hash key is shorter than 32 characters). Manual review still works.");
}

if (config.session.allowBearer) {
  console.warn("WARNING: ALLOW_TOKEN_AUTH is on. Session tokens are returned to the page. Use it for testing only.");
}

const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`NMREP API listening on ${config.host}:${config.port} (${config.nodeEnv}). Allowed origins: ${config.corsOrigins.join(", ")}`);
});

// Reminders (a programme closing soon, a training session tomorrow). Safe to run on more than one server: each
// reminder is recorded under a unique key, so nobody is told twice.
const stopReminders = config.reminders.enabled ? startReminderScheduler(config.reminders) : () => {};
if (!config.reminders.enabled) console.log("Reminders are off (REMINDERS_ENABLED=false).");

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  stopReminders();
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
