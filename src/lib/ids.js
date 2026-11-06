import { randomInt } from "node:crypto";
import { Business } from "../models/Business.js";

/**
 * Issues a NMREP Business ID, for example NMREP-2026-48201937. The number is random, so it says nothing about when the
 * business registered or how many came before it. It is checked against the businesses that already have one (and the
 * database refuses a repeat), so two businesses never share an ID.
 */
export async function issueNmrepId() {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `NMREP-${year}-${randomInt(10_000_000, 100_000_000)}`;
    if (!(await Business.exists({ nmrepId: id }))) return id;
  }
  throw new Error("Could not find a free NMREP ID.");
}
