import "dotenv/config";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

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

const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`NMREP API listening on port ${config.port} (${config.nodeEnv}). Allowed origins: ${config.corsOrigins.join(", ")}`);
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
