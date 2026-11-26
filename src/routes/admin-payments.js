import { Router } from "express";
import { toCsv } from "../lib/csv.js";
import { lagosRange } from "../lib/date-range.js";
import { audit } from "../models/AuditLog.js";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { Business } from "../models/Business.js";
import { PlaySubscription } from "../models/PlaySubscription.js";
import { Payment, paymentStatuses } from "../models/Payment.js";
import { User } from "../models/User.js";

const day = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.")
    .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "That is not a real date.")
    .optional(),
);
const querySchema = z
  .object({
    status: z.enum([...paymentStatuses, "all"]).default("success"),
    provider: z.enum(["paystack", "alatpay", "google_play", "all"]).default("all"),
    // A time range in Nigerian days: the day a payment was made (or, if it never was, started).
    from: day,
    to: day,
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "The start date must not be after the end date.", path: ["to"] });

/** The payments in the filter: status, gateway and the time range (the paid day, else the day it was started). */
function filterOf({ status, provider, from, to }) {
  const match = {};
  if (status !== "all") match.status = status;
  if (provider !== "all") match.provider = provider;
  const range = lagosRange({ from, to });
  if (range) match.$or = [{ paidAt: range }, { paidAt: null, createdAt: range }];
  return { match, range };
}

/**
 * Google Play subscriptions as payment-shaped rows, so the list and the spreadsheet can show them beside the website
 * payments. Active means "Paid", ended means "Failed" (the screen words them Active and Ended). The date is the day the
 * purchase was first confirmed. The amount is Google's recurring price when Google reports one, before tax and before
 * Google's share; the Play Console is the record of what is really paid out. The purchase token is never part of a row.
 */
async function playRows({ status, provider, from, to }, limit) {
  if (!["all", "google_play"].includes(provider) || status === "pending") return [];
  const match = {};
  if (status === "success") match.entitled = true;
  if (status === "failed") match.entitled = false;
  const range = lagosRange({ from, to });
  if (range) match.createdAt = range;
  const rows = await PlaySubscription.find(match).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    _id: r._id,
    user: r.user,
    reference: r.orderId || "Google Play",
    provider: "google_play",
    amountKobo: r.priceAmount === null || r.priceAmount === undefined ? null : Math.round(r.priceAmount * 100),
    currency: r.priceCurrency || "NGN",
    years: 1,
    status: r.entitled ? "success" : "failed",
    paidAt: r.createdAt,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    autoRenewing: r.autoRenewing,
  }));
}

/**
 * Registration fee payments, for administrators and the super admin: who paid, how much, through which gateway and when, with a link to
 * the business. Card and bank details never reach NMREP, so none exist here.
 */
export function adminPaymentRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  router.get("/", async (req, res) => {
    const q = querySchema.parse(req.query);
    const { match } = filterOf(q);

    // The totals follow the time range (and the gateway), whichever status tab is open.
    const totalsMatch = filterOf({ ...q, status: "all" }).match;
    const webRows = q.provider === "google_play" ? [] : await Payment.find(match).sort({ paidAt: -1, createdAt: -1 }).limit(300).lean();
    const [totals, playAll] = await Promise.all([
      q.provider === "google_play" ? [] : Payment.aggregate([{ $match: totalsMatch }, { $group: { _id: "$status", count: { $sum: 1 }, kobo: { $sum: "$amountKobo" } } }]),
      playRows({ ...q, status: "all", provider: "all" }, 5000),
    ]);
    const playShown = await playRows(q, 300);
    const rows = [...webRows, ...playShown].sort((a, b) => new Date(b.paidAt ?? b.createdAt) - new Date(a.paidAt ?? a.createdAt)).slice(0, 300);
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
        // Subscriptions bought in the app through Google Play. "Estimated" adds up Google's reported recurring price for the
        // active ones (naira only); the Play Console has the real amounts after tax and Google's share.
        play: {
          active: playAll.filter((p) => p.status === "success").length,
          ended: playAll.filter((p) => p.status === "failed").length,
          estimatedNaira: playAll.filter((p) => p.status === "success" && p.currency === "NGN" && p.amountKobo !== null).reduce((n, p) => n + p.amountKobo / 100, 0),
        },
      },
      items: rows.map((p) => {
        const user = userOf.get(String(p.user));
        const business = businessOf.get(String(p.user));
        return {
          id: String(p._id),
          reference: p.reference,
          provider: p.provider ?? "paystack",
          amount: p.amountKobo === null ? null : p.amountKobo / 100,
          years: p.years ?? 1,
          ...(p.provider === "google_play" ? { expiresAt: p.expiresAt ?? null, autoRenewing: Boolean(p.autoRenewing) } : {}),
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

  // The same payments as a spreadsheet (every one in the range, not only the first 300).
  router.get("/export.csv", async (req, res) => {
    const q = querySchema.parse(req.query);
    const { match } = filterOf(q);
    const web = q.provider === "google_play" ? [] : await Payment.find(match).sort({ paidAt: -1, createdAt: -1 }).limit(20000).lean();
    const rows = [...web, ...(await playRows(q, 20000))].sort((a, b) => new Date(b.paidAt ?? b.createdAt) - new Date(a.paidAt ?? a.createdAt));
    const ids = rows.map((p) => p.user);
    const [users, businesses] = await Promise.all([
      User.find({ _id: mongoose.trusted({ $in: ids }) }).select("fullName email phone").lean(),
      Business.find({ owner: mongoose.trusted({ $in: ids }) }).select("owner businessName state lga sector nmrepId").lean(),
    ]);
    const userOf = new Map(users.map((u) => [String(u._id), u]));
    const businessOf = new Map(businesses.map((b) => [String(b.owner), b]));
    const csv = toCsv(
      [
        { header: "Date (paid, or started if unpaid)", value: (p) => p.paidAt ?? p.createdAt },
        { header: "Status", value: (p) => p.status },
        { header: "Gateway", value: (p) => p.provider ?? "paystack" },
        { header: "Reference", value: (p) => p.reference },
        { header: "Years", value: (p) => p.years ?? 1 },
        { header: "Amount", value: (p) => (p.amountKobo === null ? "" : p.amountKobo / 100) },
        { header: "Currency", value: (p) => p.currency ?? "NGN" },
        { header: "Business", value: (p) => businessOf.get(String(p.user))?.businessName ?? "" },
        { header: "NMREP ID", value: (p) => businessOf.get(String(p.user))?.nmrepId ?? "" },
        { header: "State", value: (p) => businessOf.get(String(p.user))?.state ?? "" },
        { header: "LGA", value: (p) => businessOf.get(String(p.user))?.lga ?? "" },
        { header: "Sector", value: (p) => businessOf.get(String(p.user))?.sector ?? "" },
        { header: "Owner", value: (p) => userOf.get(String(p.user))?.fullName ?? "" },
        { header: "Owner email", value: (p) => userOf.get(String(p.user))?.email ?? "" },
        { header: "Owner phone", value: (p) => userOf.get(String(p.user))?.phone ?? "" },
      ],
      rows,
    );
    const used = Object.entries(q).filter(([, v]) => v && v !== "all").map(([k, v]) => `${k}=${v}`).join(", ");
    await audit(req.user, "export.payments", `Exported ${rows.length} payments to CSV${used ? ` (${used})` : ""}`, { type: "export" });
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="nmrep-payments.csv"' });
    res.send(csv);
  });

  return router;
}
