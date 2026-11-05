import { Router } from "express";
import { z } from "zod";
import { businessCounts, lgaKey } from "../lib/lgas.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { audit } from "../models/AuditLog.js";
import { Business } from "../models/Business.js";
import { Lga } from "../models/Lga.js";
import { states } from "../options.js";
import { idParamSchema, oneOf, text } from "../schemas.js";

const createSchema = z.object({ state: oneOf(states), name: text(80) }).strict();
const patchSchema = z
  .object({ name: text(80).optional(), active: z.boolean({ message: "Choose on or off." }).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

function parseId(value) {
  const parsed = idParamSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "not_found", "Not found.");
  return parsed.data;
}

const taken = () => new ApiError(409, "lga_exists", "This state already has a local government area with that name.", { name: "This state already has a local government area with that name." });

/**
 * Managing the local government areas, super admin only: see them all with how many businesses use each, add one, rename one
 * (businesses that carry the old name are moved to the new one), turn one off or on, or delete one that nobody uses.
 * Every change is written to the activity log.
 */
export function adminLocationRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("super_admin"), requirePasswordChanged);

  router.get("/", async (_req, res) => {
    const [rows, counts] = await Promise.all([Lga.find().sort({ state: 1, name: 1 }).lean(), businessCounts(Business)]);
    const byState = new Map(states.map((s) => [s, []]));
    for (const r of rows) byState.get(r.state)?.push({ id: String(r._id), name: r.name, active: r.active, businesses: counts.get(`${r.state}|${lgaKey(r.name)}`) ?? 0 });
    res.json({
      states: [...byState.entries()].map(([state, lgas]) => ({ state, total: lgas.length, active: lgas.filter((l) => l.active).length, lgas })),
      total: rows.length,
    });
  });

  router.post("/lgas", async (req, res) => {
    const { state, name } = createSchema.parse(req.body);
    let created;
    try {
      created = await Lga.create({ state, name });
    } catch (err) {
      if (err?.code === 11000) throw taken();
      throw err;
    }
    await audit(req.user, "location.create", `Added the local government area "${name}" to ${state}`, { type: "lga", id: created._id });
    res.status(201).json({ lga: { id: String(created._id), state, name: created.name, active: true, businesses: 0 } });
  });

  router.patch("/lgas/:id", async (req, res) => {
    const patch = patchSchema.parse(req.body);
    const lga = await Lga.findById(parseId(req.params.id));
    if (!lga) throw new ApiError(404, "not_found", "Not found.");
    const before = lga.name;
    let moved = 0;
    if (patch.name !== undefined && patch.name !== lga.name) {
      lga.name = patch.name;
      try {
        await lga.save();
      } catch (err) {
        if (err?.code === 11000) throw taken();
        throw err;
      }
      // Businesses that carry the old name are moved to the new one, so nobody is left with a name that is no longer offered.
      moved = (await Business.updateMany({ state: lga.state, lga: before }, { $set: { lga: lga.name } })).modifiedCount;
      await audit(req.user, "location.rename", `Renamed "${before}" to "${lga.name}" in ${lga.state} (${moved} business(es) updated)`, { type: "lga", id: lga._id });
    }
    if (patch.active !== undefined && patch.active !== lga.active) {
      lga.active = patch.active;
      await lga.save();
      await audit(req.user, "location.toggle", `Turned ${patch.active ? "on" : "off"} "${lga.name}" in ${lga.state}`, { type: "lga", id: lga._id });
    }
    const counts = await businessCounts(Business);
    res.json({ lga: { id: String(lga._id), state: lga.state, name: lga.name, active: lga.active, businesses: counts.get(`${lga.state}|${lgaKey(lga.name)}`) ?? 0 }, businessesUpdated: moved });
  });

  router.delete("/lgas/:id", async (req, res) => {
    const lga = await Lga.findById(parseId(req.params.id));
    if (!lga) throw new ApiError(404, "not_found", "Not found.");
    const used = await Business.countDocuments({ state: lga.state, lga: lga.name });
    if (used > 0) throw new ApiError(409, "lga_in_use", `${used} business(es) use this area. Turn it off instead of deleting it.`);
    await lga.deleteOne();
    await audit(req.user, "location.delete", `Deleted the local government area "${lga.name}" from ${lga.state}`, { type: "lga", id: lga._id });
    res.status(204).end();
  });

  return router;
}
