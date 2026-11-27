import { Router } from "express";
import { derivedFor, entriesFor } from "../lib/impact.js";
import { ApiError } from "../middleware/errors.js";
import { requirePaidRegistration } from "../middleware/paid.js";
import { requireAuth, requireRole } from "../middleware/security.js";
import { Business } from "../models/Business.js";
import { ImpactEntry } from "../models/ImpactEntry.js";
import { impactBodySchema, impactYearParam } from "../schemas.js";

/** The owner's impact: the jobs the business created each year (typed in) and what the platform counts for it. */
export function impactRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("msme_owner"), requirePaidRegistration(config));

  const own = async (req) => {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw new ApiError(404, "not_found", "Business profile not found.");
    return business;
  };

  router.get("/", async (req, res) => {
    const business = await own(req);
    res.json({ entries: (await entriesFor(business._id)).map((e) => e.toJSON()), derived: await derivedFor(business), thisYear: new Date().getFullYear() });
  });

  // The jobs created in a year. Safe to repeat; the owner can correct a figure by sending a new one.
  router.put("/:year", async (req, res) => {
    const parsed = impactYearParam.safeParse(req.params.year);
    if (!parsed.success || parsed.data > new Date().getFullYear()) throw new ApiError(422, "validation", "Choose a year up to this year.", { year: "Choose a year up to this year." });
    const { jobsCreated } = impactBodySchema.parse(req.body);
    const business = await own(req);
    const entry = await ImpactEntry.findOneAndUpdate(
      { business: business._id, year: parsed.data },
      { $set: { jobsCreated, enteredBy: "owner", enteredByName: req.user.fullName.slice(0, 100) } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    res.json({ entry: entry.toJSON() });
  });

  return router;
}
