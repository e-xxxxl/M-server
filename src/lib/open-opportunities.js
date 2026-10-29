import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { Opportunity } from "../models/Opportunity.js";
import { Organisation } from "../models/Organisation.js";
import { evaluate } from "./eligibility.js";

/** An opportunity of a switched-off organisation is not shown and does not accept applications. */
export const organisationActive = (org) => !org || org.active;

/**
 * The opportunities an owner can see right now: open, started, not past the deadline, and from an active organisation,
 * each with how the owner's business compares and the status of the owner's own application (or null).
 * Unsorted and with the full checklist: callers shape it for their own response.
 */
export async function openOpportunitiesFor(business, ownerId, { filter = {}, now = new Date() } = {}) {
  const open = await Opportunity.find({ status: "Open", ...filter });
  const orgRows = await Organisation.find({ _id: mongoose.trusted({ $in: open.map((o) => o.organisation).filter(Boolean) }) }).select("name active").lean();
  const orgs = new Map(orgRows.map((o) => [String(o._id), o]));
  const visible = open.filter((o) => o.isAcceptingApplications(now) && organisationActive(o.organisation ? orgs.get(String(o.organisation)) : null));
  const mine = await Application.find({ owner: ownerId, opportunity: mongoose.trusted({ $in: visible.map((o) => o._id) }) }).select("opportunity status");
  const statusOf = new Map(mine.map((a) => [String(a.opportunity), a.status]));
  return visible.map((o) => ({
    opportunity: o,
    organisationName: o.organisation ? (orgs.get(String(o.organisation))?.name ?? null) : null,
    fit: evaluate(o.criteria, business, now),
    applicationStatus: statusOf.get(String(o._id)) ?? null,
  }));
}

/** An application in these states is still being worked on by the owner, so the opportunity can still be applied to. */
const stillOpenToApply = [null, "Draft", "Withdrawn"];

/**
 * How many open opportunities the business meets every Required requirement for and has not applied to yet. This is a
 * count of the same "Eligible" label the list shows, never a different calculation.
 */
export async function countEligible(business, ownerId) {
  const items = await openOpportunitiesFor(business, ownerId);
  return items.filter((i) => i.fit.label === "Eligible" && stillOpenToApply.includes(i.applicationStatus)).length;
}
