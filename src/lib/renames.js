import { Business } from "../models/Business.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";

/**
 * Wording changes that touch stored values: "Funding" became "Opportunity" (the opportunity type), "Funding Partner"
 * became "Opportunity Partner" (an organisation type) and one answer of the size-of-opportunity question was reworded.
 * Safe to run on every start: it only touches records that still carry an old value.
 */
export async function applyRenames() {
  const changed = {};
  changed.opportunities = (await Opportunity.updateMany({ type: "Funding" }, { $set: { type: "Opportunity" } })).modifiedCount;
  changed.organisations = (await Organisation.updateMany({ type: "Funding Partner" }, { $set: { type: "Opportunity Partner" } })).modifiedCount;
  changed.businesses = (await Business.updateMany({ fundingNeeds: "Not looking for funding now" }, { $set: { fundingNeeds: "Not looking for an opportunity now" } })).modifiedCount;
  return changed;
}
