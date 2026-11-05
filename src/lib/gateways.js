/**
 * The payment gateways NMREP can take the registration fee through, and which one is in use.
 *
 * - "alatpay": bank transfer to a one-time virtual account (see lib/alatpay.js).
 * - "paystack": card and bank payments on Paystack's hosted page (see lib/paystack.js).
 *
 * A gateway is "configured" when its credentials are in the server's environment. Which configured gateway is in use is
 * chosen by the super admin in Settings (or by PAYMENT_GATEWAY on the server); with no choice at all, the first
 * configured one is used, ALATPay before Paystack.
 */
export const gatewayNames = ["alatpay", "paystack"];

export const gatewayLabels = { alatpay: "ALATPay (bank transfer)", paystack: "Paystack (card and bank)" };

export function isConfigured(config, name) {
  if (name === "alatpay") return Boolean(config.payments.alatpay.secretKey && config.payments.alatpay.businessId);
  if (name === "paystack") return Boolean(config.payments.secretKey);
  return false;
}

/** The gateway in use: the chosen one, or the first configured one when nothing was chosen. */
export function pickGateway(config, chosen) {
  if (gatewayNames.includes(chosen)) return chosen;
  return gatewayNames.find((name) => isConfigured(config, name)) ?? "alatpay";
}
