// Switches off two-factor sign-in for one staff account, for a super admin who lost their phone and recovery codes
// (another super admin cannot be reset from the portal). Run it on the server that has backend/.env:
//
//     npm run reset-two-factor -- someone@example.com
//
// The account then signs in with its password alone and can set two-factor up again from its Account page.
import "dotenv/config";
import mongoose from "mongoose";
import { loadConfig } from "../src/config.js";
import { Session } from "../src/models/Session.js";
import { User } from "../src/models/User.js";

const email = String(process.argv[2] ?? "").trim().toLowerCase();
const config = loadConfig();
if (!email.includes("@")) {
  console.error("Usage: npm run reset-two-factor -- someone@example.com");
  process.exit(1);
}
if (!config.mongodbUri) {
  console.error("MONGODB_URI is not set. Copy backend/.env.example to backend/.env and add it first.");
  process.exit(1);
}

await mongoose.connect(config.mongodbUri);
try {
  const user = await User.findOne({ email });
  if (!user || !["admin", "super_admin"].includes(user.role)) {
    console.error("No staff account with that email.");
    process.exitCode = 1;
  } else {
    user.twoFactorEnabled = false;
    user.twoFactorSecret = "";
    user.twoFactorLastStep = 0;
    user.twoFactorRecovery = [];
    await user.save();
    await Session.deleteMany({ user: user._id });
    console.log(`Two-factor sign-in is off for ${user.fullName} (${user.email}). They are signed out everywhere.`);
  }
} finally {
  await mongoose.disconnect();
}
