import { ApiError } from "./errors.js";

/**
 * Holds a business owner back until the yearly registration fee is paid. Used after requireAuth on every owner area
 * except the account, notifications and the payment itself. Staff and partners are never held. When no Paystack key
 * is set the fee is off and nobody is held.
 */
export function requirePaidRegistration(config) {
  return (req, _res, next) => {
    if (!config.payments.enabled || req.user.role !== "msme_owner") return next();
    const until = req.user.registrationPaidUntil;
    if (until && until > new Date()) return next();
    throw new ApiError(402, "payment_required", "Please pay your registration fee to continue.");
  };
}
