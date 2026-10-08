// Runs the API against a temporary in-memory MongoDB, so you can try everything without
// Atlas. Data is lost when you stop it. Usage: npm run dev:memory
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
// A smaller MongoDB for the temporary test database than the library default (it downloads once).
process.env.MONGOMS_VERSION ??= "6.0.19";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/lib/crypto.js";
import { newTemporaryPassword } from "../src/lib/codes.js";
import { User } from "../src/models/User.js";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3100",
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS ?? "10",
});

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
