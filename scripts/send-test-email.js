// Sends one test email through Resend, to check the API key, the sender address and the domain.
// Usage (from the backend folder, with backend/.env filled in):
//   npm run send-test-email -- you@example.com
// It prints whether Resend accepted the message. It never prints the API key.
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { configureMailer } from "../src/lib/mailer.js";
import { updateEmail } from "../src/lib/email-templates.js";

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
  console.error("Give the address to send to, for example: npm run send-test-email -- you@example.com");
  process.exit(1);
}

const config = loadConfig();
const mail = configureMailer(config, { isProd: true }); // never print the message body here
if (!mail.enabled) {
  console.error("Email is off. Set RESEND_API_KEY and EMAIL_FROM in backend/.env first.");
  process.exit(1);
}

const message = updateEmail({ fullName: "there" }, "This is a test email from NMREP", `${config.email.appUrl}/login/`);
const result = await mail.send({ to, ...message });
if (result.ok) {
  console.log(`Resend accepted the message (id ${result.id}). Check the inbox of ${to}, and the spam folder.`);
} else {
  console.error(
    result.status
      ? `Resend refused the message (HTTP ${result.status}). The usual causes: the domain in EMAIL_FROM is not verified in Resend, the API key is wrong or restricted, or the free plan only allows sending to your own address.`
      : "The message could not be sent (network problem or timeout).",
  );
  process.exit(1);
}
