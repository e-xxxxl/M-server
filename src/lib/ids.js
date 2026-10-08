import { Counter } from "../models/Counter.js";

/**
 * Issues the next NMREP Business ID, for example NMREP-2026-000184. The counter is
 * incremented atomically, so two admins verifying at the same moment never get the same ID.
 */
export async function issueNmrepId() {
  const year = new Date().getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { _id: `nmrep-id-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `NMREP-${year}-${String(counter.seq).padStart(6, "0")}`;
}
