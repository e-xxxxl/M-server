// Sends ONE test push notification to a phone you name (an Expo push token or a Firebase device token), and says what
// happened. Usage:
//   npm run push-check -- <the phone's push token>
//
// An Expo token (ExponentPushToken[...]) needs no key. A raw Firebase device token needs the Firebase key from backend/.env
// (FIREBASE_SERVICE_ACCOUNT_FILE or FIREBASE_SERVICE_ACCOUNT_BASE64), read the same way the server does. The key and the
// token are never printed. Get the token from the app developer's debug screen.
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { configurePush, push } from "../src/lib/push.js";
import { isPushToken } from "../src/lib/push-token.js";

const token = process.argv[2] ?? "";
if (!isPushToken(token)) {
  console.error("Give the phone's push token: npm run push-check -- <token>   (ExponentPushToken[...] or a Firebase device token)");
  process.exit(1);
}

const config = loadConfig(process.env);
configurePush(config);
if (!push.enabled) {
  console.error("Push is switched off (PUSH_ENABLED=false in backend/.env).");
  process.exit(1);
}
if (!token.startsWith("Expo") && !push.firebase) {
  console.error("This is a Firebase device token, and no Firebase key is set. Set FIREBASE_SERVICE_ACCOUNT_FILE in backend/.env to the service account JSON file.");
  process.exit(1);
}

const result = await push.send([{ to: token, title: "NMREP test notification", body: "If you can read this, push works.", data: { link: "/notifications", type: "test" } }]);
if (result.sent === 1) console.log("Sent. Look at the phone: the notification should arrive in a few seconds.");
else if (result.invalidTokens.length > 0) console.log("The push service says this token is not a working phone (wrong project, or the app was reinstalled). Get a fresh token from the app.");
else console.log("Not sent. The reason is in the lines above (for a Firebase token: the service account key, its permission, or the Firebase Cloud Messaging API not enabled).");
