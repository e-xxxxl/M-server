import crypto from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../middleware/errors.js";
import { notify } from "../models/Notification.js";
import { Payment } from "../models/Payment.js";
import { User } from "../models/User.js";
import { sendPaymentReceipt } from "./account-emails.js";
import { emailSettings } from "./mailer.js";
import { paystack } from "./paystack.js";

/**
 * The yearly registration fee. Every business owner pays it to complete registration, and again each year. Money is
 * taken by Paystack on its own page; this file only starts a payment, checks its outcome with Paystack, and records
 * the year it buys. The fee is switched on by setting PAYSTACK_SECRET_KEY: without it nobody is asked to pay.
 */

const DAY = 24 * 60 * 60 * 1000;
/** From this many days before a paid year ends, the next year can be bought. */
const RENEW_WINDOW_DAYS = 30;

export const feeKobo = (config) => Math.round(config.payments.registrationFeeNaira * 100);

/** What an owner (or the app) needs to know about the fee. `paid` is true when nothing is owed, including when the fee is off. */
export function registrationState(user, config, now = new Date()) {
  const required = config.payments.enabled;
  const until = user.registrationPaidUntil ?? null;
  const current = Boolean(until && until > now);
  return {
    required,
    paid: !required || current,
    paidUntil: until,
    amount: config.payments.registrationFeeNaira,
    currency: "NGN",
    canRenew: required && current && until.getTime() - now.getTime() <= RENEW_WINDOW_DAYS * DAY,
  };
}

/** Creates a pending payment and returns where to send the payer. */
export async function startRegistrationPayment(config, user) {
  if (!config.payments.enabled || !paystack.enabled) throw new ApiError(503, "payments_unavailable", "Payments are not available right now. Please try again later.");
  const state = registrationState(user, config);
  if (state.paid && !state.canRenew) throw new ApiError(409, "already_paid", "Your registration fee is already paid.");

  const reference = `NMREG-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  const amountKobo = feeKobo(config);
  const payment = await Payment.create({ user: user._id, reference, amountKobo });
  const started = await paystack.initialize({
    email: user.email,
    amountKobo,
    reference,
    // Paystack sends the payer back here. The page then asks the API to check the payment.
    callbackUrl: `${emailSettings().appUrl}/pay/`,
    metadata: { purpose: "registration" },
  });
  if (started.unavailable) {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: "failed" } });
    throw new ApiError(503, "payments_unavailable", "Payments are not available right now. Please try again later.");
  }
  return { authorizationUrl: started.authorizationUrl, reference, amount: config.payments.registrationFeeNaira, currency: "NGN" };
}

/**
 * Checks a payment with Paystack and, the first time it is seen as paid, buys the owner a year. Safe to call any number
 * of times and from two places at once (the payer's browser and the webhook): only one of them records the payment.
 * Returns { outcome: "success" | "pending" | "failed" | "not_found", ... }.
 */
export async function settlePayment(config, reference, { userId = null, now = new Date() } = {}) {
  const payment = await Payment.findOne({ reference: String(reference).slice(0, 80) });
  if (!payment || (userId && String(payment.user) !== String(userId))) return { outcome: "not_found" };
  if (payment.status === "success") return { outcome: "success", payment, alreadyRecorded: true };

  const r = await paystack.verify(payment.reference);
  if (r.unavailable) throw new ApiError(503, "payments_unavailable", "We could not check the payment just now. Please try again in a moment.");
  if (!r.found) return { outcome: "pending", payment };

  if (r.status === "success") {
    // The amount and currency must be what the server asked for. Anything else is not our payment.
    if (r.amountKobo !== payment.amountKobo || r.currency !== payment.currency) {
      await Payment.updateOne({ _id: payment._id }, { $set: { status: "failed" } });
      console.error("A registration payment did not match the amount asked for. It was not accepted.");
      return { outcome: "failed", payment };
    }
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: mongoose.trusted({ $ne: "success" }) },
      { $set: { status: "success", paidAt: r.paidAt ?? now } },
      { returnDocument: "after" },
    );
    if (!claimed) return { outcome: "success", payment, alreadyRecorded: true };

    const user = await User.findById(payment.user);
    if (user) {
      // Renewing early adds a year to the end of the current one, so nothing already paid for is lost.
      const base = user.registrationPaidUntil && user.registrationPaidUntil > now ? user.registrationPaidUntil : now;
      user.registrationPaidUntil = new Date(base.getTime() + config.payments.periodDays * DAY);
      await user.save();
      await notify(user._id, {
        type: "payment",
        title: "Registration fee received",
        body: `Thank you. Your registration is paid until ${user.registrationPaidUntil.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" })}.`,
        link: "/dashboard/",
      });
      sendPaymentReceipt(user, { amount: config.payments.registrationFeeNaira, reference: payment.reference, paidUntil: user.registrationPaidUntil });
    }
    return { outcome: "success", payment: claimed };
  }

  if (["failed", "abandoned", "reversed"].includes(r.status)) {
    await Payment.updateOne({ _id: payment._id, status: "pending" }, { $set: { status: "failed" } });
    return { outcome: "failed", payment };
  }
  return { outcome: "pending", payment };
}
