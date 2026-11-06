import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { Business } from "../models/Business.js";
import { Payment, paymentStatuses } from "../models/Payment.js";
import { User } from "../models/User.js";

const querySchema = z
  .object({
    status: z.enum([...paymentStatuses, "all"]).default("success"),
    provider: z.enum(["paystack", "alatpay", "all"]).default("all"),
  })
  .strict();

/**
 * Registration fee payments, for the super admin: who paid, how much, through which gateway and when, with a link to
 * the business. Card and bank details never reach NMREP, so none exist here.
 */
export function adminPaymentRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("super_admin"), requirePasswordChanged);

  router.get("/", async (req, res) => {
    const { status, provider } = querySchema.parse(req.query);
    const match = {};
    if (status !== "all") match.status = status;
    if (provider !== "all") match.provider = provider;

    const [rows, totals] = await Promise.all([
      Payment.find(match).sort({ paidAt: -1, createdAt: -1 }).limit(300).lean(),
      Payment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 }, kobo: { $sum: "$amountKobo" } } }]),
    ]);
    const ids = rows.map((p) => p.user);
    const [users, businesses] = await Promise.all([
      User.find({ _id: mongoose.trusted({ $in: ids }) }).select("fullName email").lean(),
      Business.find({ owner: mongoose.trusted({ $in: ids }) }).select("owner businessName state nmrepId").lean(),
    ]);
    const userOf = new Map(users.map((u) => [String(u._id), u]));
    const businessOf = new Map(businesses.map((b) => [String(b.owner), b]));
    const sum = (s) => totals.find((t) => t._id === s) ?? { count: 0, kobo: 0 };

    res.json({
      totals: {
        paid: sum("success").count,
        collectedNaira: sum("success").kobo / 100,
        pending: sum("pending").count,
        failed: sum("failed").count,
      },
      items: rows.map((p) => {
        const user = userOf.get(String(p.user));
        const business = businessOf.get(String(p.user));
        return {
          id: String(p._id),
          reference: p.reference,
          provider: p.provider ?? "paystack",
          amount: p.amountKobo / 100,
          currency: p.currency,
          status: p.status,
          paidAt: p.paidAt,
          createdAt: p.createdAt,
          businessId: business ? String(business._id) : null,
          businessName: business?.businessName ?? "Business removed",
          state: business?.state ?? "",
          ownerName: user?.fullName ?? "",
          ownerEmail: user?.email ?? "",
        };
      }),
    });
  });

  return router;
}
