/**
 * The words of every email NMREP sends. Plain, short and safe:
 * - never a password (temporary passwords are shown once in the portal, not emailed),
 * - never a staff note or any profile detail,
 * - links only to the NMREP website.
 */

import { emailSettings } from "./mailer.js";

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstName = (user) => String(user.fullName ?? "").trim().split(/\s+/)[0] || "there";

// Inter is loaded with a link where the mail program allows it (Apple Mail, Outlook for Mac and others). Gmail and some
// others ignore it, so the same stack falls back to Arial, which looks close.
const FONT = "'Inter',Arial,Helvetica,sans-serif";

function layout({ greeting, paragraphs, button, footer, unsubscribeUrl }) {
  const text = [greeting, "", ...paragraphs, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", footer ?? "NMREP", ...(unsubscribeUrl ? ["", `Stop these emails: ${unsubscribeUrl}`] : [])].join("\n");
  // The logo is a file on the NMREP website (public/email-logo.png), so it shows once the website is uploaded.
  const site = emailSettings().appUrl.replace(/\/+$/, "");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;background:#f1f4f2;font-family:${FONT};color:#171717">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="background:#ffffff;border-radius:12px 12px 0 0;border-top:5px solid #167a40;padding:24px 32px 18px;border-bottom:1px solid #e4e8e5">
<a href="${esc(site)}" style="text-decoration:none"><img src="${esc(site)}/email-logo.png" width="150" height="60" alt="NMREP" style="display:block;border:0;outline:none;height:auto;max-width:150px;font-family:${FONT};font-size:20px;font-weight:700;color:#167a40"></a>
</td></tr>
<tr><td style="background:#ffffff;padding:28px 32px 30px;font-family:${FONT};font-size:16px;line-height:1.6;color:#171717">
<p style="margin:0 0 16px;font-size:18px;font-weight:600">${esc(greeting)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("\n")}
${button ? `<p style="margin:26px 0"><a href="${esc(button.url)}" style="background:#167a40;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:8px;font-weight:600;display:inline-block;font-family:${FONT}">${esc(button.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#5c5c5c">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${esc(button.url)}</span></p>` : ""}
<p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #e4e8e5;font-size:13px;line-height:1.5;color:#5c5c5c">${esc(footer ?? "You received this email because of activity on your NMREP account.")}${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:#5c5c5c;text-decoration:underline">Stop these emails</a>.` : ""}</p>
</td></tr>
<tr><td style="background:#0f5e30;border-radius:0 0 12px 12px;padding:16px 32px;font-family:${FONT};font-size:12px;line-height:1.5;color:#dcebe1">
NMREP &middot; Digital business platform for Nigerian MSMEs &middot; <a href="${esc(site)}" style="color:#ffffff;text-decoration:underline">nmrep.ng</a>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

export function verifyEmail(user, url) {
  return {
    subject: "Confirm your email address for NMREP",
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: ["Thank you for registering your business on NMREP.", "Please confirm that this is your email address. The link works for 48 hours."],
      button: { label: "Confirm my email address", url },
      footer: "If you did not create an NMREP account, you can ignore this email.",
    }),
  };
}

export function resetPasswordEmail(user, url) {
  return {
    subject: "Reset your NMREP password",
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: [
        "We received a request to reset the password for your NMREP account.",
        "Use the button below to choose a new password. The link works once and expires in 1 hour.",
      ],
      button: { label: "Choose a new password", url },
      footer: "If you did not ask for this, you can ignore this email. Your password has not been changed.",
    }),
  };
}

export function passwordChangedEmail(user, loginUrl) {
  return {
    subject: "Your NMREP password was changed",
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: [
        "The password for your NMREP account has just been changed, and you were signed out on all devices.",
        "If this was you, there is nothing more to do. If it was not you, reset your password straight away and contact NMREP.",
      ],
      button: { label: "Go to NMREP", url: loginUrl },
    }),
  };
}

export function accountDeletedEmail(user) {
  return {
    subject: "Your NMREP account has been deleted",
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: [
        "Your NMREP account and business profile have been deleted, as you asked.",
        "If you did not ask for this, contact NMREP straight away.",
      ],
      footer: "This is the last email you will receive from NMREP about this account.",
    }),
  };
}

/**
 * A short heads-up that something changed. The details stay behind the login. `body` is added only for messages an
 * administrator wrote or reminders about a programme (never for a verification or application decision).
 * `unsubscribeUrl` adds the "Stop these emails" link.
 */
export function updateEmail(user, title, url, { body = "", unsubscribeUrl = "" } = {}) {
  return {
    subject: title,
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: body ? [title, body, "Log in to NMREP to see more."] : [title, "Log in to NMREP to see the details."],
      button: { label: "Open NMREP", url },
      unsubscribeUrl,
    }),
  };
}

/** The receipt for the yearly registration fee. */
export function paymentReceiptEmail(user, { amount, reference, paidUntil, url }) {
  const money = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(amount);
  const until = paidUntil.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
  return {
    subject: "Your NMREP registration fee receipt",
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: [
        `Thank you. We received your registration fee of ${money}.`,
        `Your registration is paid until ${until}. Payment reference: ${reference}.`,
        "Keep this email as your receipt. Card details are entered on Paystack's page and never reach NMREP.",
      ],
      button: { label: "Go to NMREP", url },
    }),
  };
}
