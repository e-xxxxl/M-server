import crypto from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { registrationState, settlePayment, startRegistrationPayment } from "../lib/payments.js";
import { validSignature } from "../lib/paystack.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { Payment } from "../models/Payment.js";
import { User } from "../models/User.js";

const verifySchema = z.object({ reference: z.string().trim().min(1).max(80) }).strict();

/** The yearly registration fee, for business owners: what is owed, start a payment, and check one. */
export function paymentRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"));

  router.get("/registration", async (req, res) => {
    const latest = await Payment.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(10);
    res.json({ registration: registrationState(req.user, config), payments: latest.map((p) => p.toJSON()) });
  });

  // Returns the Paystack page to send the owner to. The app opens it in a browser view; the website goes there directly.
  router.post("/registration/initialize", async (req, res) => {
    const started = await startRegistrationPayment(config, req.user);
    res.status(201).json(started);
  });

  // Called when the owner comes back from Paystack, with the reference from the address. Safe to repeat.
  router.post("/registration/verify", async (req, res) => {
    const { reference } = verifySchema.parse(req.body);
    const result = await settlePayment(config, reference, { userId: req.user._id });
    if (result.outcome === "not_found") throw new ApiError(404, "not_found", "Not found.");
    // The user object was loaded before the payment was recorded, so read the new state from the database.
    const fresh = await User.findById(req.user._id);
    res.json({ outcome: result.outcome, registration: registrationState(fresh, config) });
  });

  return router;
}

/**
 * Paystack tells the server about a payment here (the "charge.success" event), even if the payer closed the page
 * before coming back. The signature proves it came from Paystack, and the payment is still checked with Paystack
 * before it is accepted. Mounted before the JSON reader because the signature is made over the exact bytes sent.
 */
export function paystackWebhook({ config }) {
  return [
    express.raw({ type: () => true, limit: "50kb" }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!validSignature(raw, req.get("x-paystack-signature"), config.payments.secretKey)) {
        throw new ApiError(401, "invalid_signature", "Invalid signature.");
      }
      let event;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new ApiError(400, "bad_request", "Invalid body.");
      }
      const reference = event?.data?.reference;
      if (event?.event === "charge.success" && typeof reference === "string" && reference.startsWith("NMREG-")) {
        // A failure here answers 5xx, so Paystack tries again later.
        await settlePayment(config, reference);
      }
      res.json({ received: true });
    },
  ];
}

/** Used by tests to make a signature the way Paystack does. */
export const signBody = (body, secretKey) => crypto.createHmac("sha512", secretKey).update(body).digest("hex");
