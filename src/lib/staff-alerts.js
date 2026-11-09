import { staffAlertEmail } from "./email-templates.js";
import { emailSettings, mailer } from "./mailer.js";

/**
 * Emails to the NMREP staff inbox (STAFF_ALERT_EMAIL, admin@nmrep.org by default) when something needs their eye: a new
 * registration, a registration fee paid, a check that needs a reviewer. Business owners never see these.
 *
 * Sending never throws and never blocks the action that caused it. An alert holds names and outcomes only: never a NIN, a
 * password, a document or a staff note, and never a phone number or an email address of the owner.
 */
export function alertStaff(config, { title, lines, path = "/admin/" }) {
  try {
    const to = config?.staffAlerts?.to ?? [];
    if (to.length === 0 || !mailer.enabled) return;
    const message = staffAlertEmail(title, lines, `${emailSettings().appUrl}${path}`);
    for (const address of to) void Promise.resolve(mailer.send({ to: address, ...message })).catch(() => null);
  } catch (err) {
    console.error("Staff alert failed:", err?.name);
  }
}

const naira = (amount) => `₦${Number(amount).toLocaleString("en-NG")}`;
const day = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
const gatewayName = { alatpay: "ALATPay (bank transfer)", paystack: "Paystack" };

/** A business has registered. */
export function alertNewRegistration(config, { business, user, referralCode = "" }) {
  alertStaff(config, {
    title: `New registration: ${business.businessName}`,
    lines: [
      `${business.businessName} has registered.`,
      `Owner: ${user.fullName}`,
      `Where: ${[business.city, business.state].filter(Boolean).join(", ")}. Sector: ${business.sector}.`,
      `Verification: ${business.verificationStatus}${business.verificationStatus === "Verified" ? " (the NIN matched)" : business.ninMasked ? (config.payments.enabled ? " (NIN given, checked once the fee is paid)" : " (NIN given, not confirmed yet)") : ""}.`,
      ...(config.payments.enabled ? ["Registration fee: not paid yet."] : []),
      ...(referralCode ? [`Referral code: ${referralCode}`] : []),
    ],
    path: `/admin/businesses/detail/?id=${business._id}`,
  });
}

/** A registration fee was paid. */
export function alertPaymentReceived(config, { business, user, payment }) {
  alertStaff(config, {
    title: `Registration fee received: ${business?.businessName ?? user.fullName}`,
    lines: [
      `${business?.businessName ?? "A business"} paid ${naira(payment.amountKobo / 100)} for ${payment.years ?? 1} year${(payment.years ?? 1) === 1 ? "" : "s"}.`,
      `Owner: ${user.fullName}`,
      `Through: ${gatewayName[payment.provider] ?? payment.provider}. Reference: ${payment.reference}.`,
      `Paid until: ${day(user.registrationPaidUntil)}.`,
    ],
    path: "/admin/payments/",
  });
}

/** A check found a record that a person must look at. */
export function alertNeedsReviewer(config, { business, user, type, reason }) {
  alertStaff(config, {
    title: `Needs a reviewer: ${business.businessName}`,
    lines: [`${business.businessName} needs a reviewer.`, `Owner: ${user.fullName}`, `${type === "nin" ? "NIN check" : "CAC check"}: ${reason}`],
    path: "/admin/verification/",
  });
}
