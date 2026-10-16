/**
 * The words of every email NMREP sends. Plain, short and safe:
 * - never a password (temporary passwords are shown once in the portal, not emailed),
 * - never a staff note or any profile detail,
 * - links only to the NMREP website.
 */

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const firstName = (user) => String(user.fullName ?? "").trim().split(/\s+/)[0] || "there";

function layout({ greeting, paragraphs, button, footer }) {
  const text = [greeting, "", ...paragraphs, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", footer ?? "NMREP"].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#171717">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">
<tr><td style="font-size:20px;font-weight:bold;color:#167a40;padding-bottom:16px">NMREP</td></tr>
<tr><td style="font-size:16px;line-height:1.5">
<p style="margin:0 0 14px">${esc(greeting)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join("\n")}
${button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#167a40;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:#5c5c5c">If the button does not work, copy this address into your browser:<br>${esc(button.url)}</p>` : ""}
<p style="margin:22px 0 0;font-size:13px;color:#5c5c5c">${esc(footer ?? "You received this email because of activity on your NMREP account.")}</p>
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

/** A short heads-up that something changed. The details stay behind the login. */
export function updateEmail(user, title, url) {
  return {
    subject: title,
    ...layout({
      greeting: `Hello ${firstName(user)},`,
      paragraphs: [title, "Log in to NMREP to see the details."],
      button: { label: "Open NMREP", url },
    }),
  };
}
