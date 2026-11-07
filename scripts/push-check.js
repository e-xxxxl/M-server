// Sends ONE test push notification through Firebase to a phone you name, and says what happened. Usage:
//   npm run push-check -- <the phone's Firebase device token>
//
// It reads the Firebase key from backend/.env (FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_BASE64), the
// same way the server does. The key and the token are never printed. Get the device token from the app developer's
// debug screen: it is the long text Firebase gives the app.
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { configurePush, push } from "../src/lib/push.js";

const token = process.argv[2] ?? "";
if (!/^[A-Za-z0-9_:-]{100,4096}$/.test(token)) {
  console.error("Give the phone's Firebase device token: npm run push-check -- <token>   (it is a long text with colons and dashes)");
  process.exit(1);
}

const config = loadConfig(process.env);
configurePush(config);
if (!push.enabled) {
  console.error("Push is off. Set FIREBASE_SERVICE_ACCOUNT_FILE in backend/.env to the service account JSON file, and check PUSH_ENABLED is not false.");
  process.exit(1);
}

const result = await push.send([{ to: token, title: "NMREP test notification", body: "If you can read this, Firebase push works.", data: { link: "/dashboard/", type: "test" } }]);
if (result.sent === 1) console.log("Sent. Look at the phone: the notification should arrive in a few seconds.");
else if (result.invalidTokens.length > 0) console.log("Firebase says this token is not a working phone (wrong project, or the app was reinstalled). Get a fresh token from the app.");
else console.log("Not sent. The reason is in the lines above (service account key, permission, or the Firebase Cloud Messaging API not enabled).");
