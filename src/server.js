import "dotenv/config";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { configureMailer } from "./lib/mailer.js";
import { configureDocumentStorage } from "./lib/document-storage.js";
import { configurePrembly } from "./lib/prembly.js";
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
if (!configureDocumentStorage(config).enabled) {
  console.warn("The document wallet is off (DOCUMENT_ENCRYPTION_KEY is not set, or is not 32 bytes as base64). Everything else still works.");
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

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
