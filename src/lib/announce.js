import { Business } from "../models/Business.js";
import { Notification } from "../models/Notification.js";
import { deliverPush } from "./push.js";
import { User } from "../models/User.js";
import { evaluate } from "./eligibility.js";

/** Tells every owner whose business already meets the required requirements about a newly opened opportunity. */
export async function announce(opportunity) {
  const link = `/dashboard/opportunities/detail/?id=${opportunity._id}`;
  let batch = [];
  const told = [];
  const flush = async () => {
    if (batch.length > 0) await Notification.insertMany(batch, { ordered: false }).catch(() => {});
    batch = [];
  };
  const title = `New opportunity: ${opportunity.title}`.slice(0, 120);
  const body = "Your business meets the required requirements.";
  // A revoked account is never told anything.
  const inactive = new Set((await User.find({ role: "msme_owner", active: false }).distinct("_id")).map(String));
  for await (const business of Business.find({}).lean().cursor()) {
    if (inactive.has(String(business.owner))) continue;
    if (evaluate(opportunity.criteria, business).label !== "Eligible") continue;
    told.push(business.owner);
    batch.push({ user: business.owner, type: "opportunity", title, body, link });
    if (batch.length >= 500) await flush();
  }
  await flush();
  // New opportunities reach phones as well, but are not emailed: that would be one email per programme per owner.
  if (told.length > 0) await deliverPush(told, { title, body, link, type: "opportunity" });
}

/**
 * Opens an opportunity. The first time it opens, owners who qualify are told. Reopening never repeats that.
 * The caller saves nothing: this function saves the opportunity itself.
 */
export async function openOpportunity(opportunity) {
  const firstOpening = !opportunity.openedAt;
  opportunity.status = "Open";
  opportunity.reviewNote = "";
  if (firstOpening) opportunity.openedAt = new Date();
  await opportunity.save();
  if (firstOpening) await announce(opportunity);
}
