import fs from "node:fs";
import { ApiError } from "../middleware/errors.js";
import { Lga } from "../models/Lga.js";

/**
 * Local government areas, by state. The list is loaded once from src/data/lgas.json (the client's list, cleaned: see
 * docs/LGA-DATA-REPORT.md) and then belongs to the database, where the super admin manages it.
 */

const seedFile = new URL("../data/lgas.json", import.meta.url);

/** Loads the starting list when there is none yet. Safe to run on every start. Returns how many were added. */
export async function seedLgas() {
  if ((await Lga.estimatedDocumentCount()) > 0) return 0;
  const data = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  const rows = Object.entries(data).flatMap(([state, names]) => names.map((name) => ({ state, name })));
  await Lga.insertMany(rows, { ordered: false });
  return rows.length;
}

/** A name with capitals, spaces and punctuation ignored, so "Ibeju Lekki" finds "Ibeju-Lekki". */
export const lgaKey = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The areas to offer, by state, and a number that changes whenever the list does (so an app can cache it). */
export async function lgaList(state = null) {
  const filter = state ? { state, active: true } : { active: true };
  const [rows, latest] = await Promise.all([Lga.find(filter).sort({ state: 1, name: 1 }).lean(), Lga.findOne().sort({ updatedAt: -1 }).select("updatedAt").lean()]);
  const lgas = {};
  for (const r of rows) (lgas[r.state] ??= []).push(r.name);
  return { version: latest ? latest.updatedAt.getTime() : 0, lgas };
}

/**
 * Checks that an area belongs to the state and returns its proper spelling. A state with no areas on file at all is not
 * checked (nothing to check against). `prefix` is for the field name in the error, for example "business.".
 */
export async function checkLocation({ state, lga }, prefix = "") {
  const rows = await Lga.find({ state }).select("name active").lean();
  if (rows.length === 0) return String(lga ?? "").trim();
  const found = rows.find((r) => r.active && lgaKey(r.name) === lgaKey(lga));
  if (!found) {
    throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`${prefix}lga`]: `Choose a local government area from the list for ${state}.` });
  }
  return found.name;
}

/** How many businesses carry each area, keyed by state and area, for the management page. */
export async function businessCounts(Business) {
  const rows = await Business.aggregate([{ $group: { _id: { state: "$state", lga: "$lga" }, n: { $sum: 1 } } }]);
  const counts = new Map();
  for (const r of rows) {
    const key = `${r._id.state}|${lgaKey(r._id.lga)}`;
    counts.set(key, (counts.get(key) ?? 0) + r.n);
  }
  return counts;
}
