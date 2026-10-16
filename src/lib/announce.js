import { Business } from "../models/Business.js";
import { Notification } from "../models/Notification.js";
import { evaluate } from "./eligibility.js";

/** Tells every owner whose business already meets the required requirements about a newly opened opportunity. */
export async function announce(opportunity) {
  const link = `/dashboard/opportunities/detail/?id=${opportunity._id}`;
  let batch = [];
  const flush = async () => {
    if (batch.length > 0) await Notification.insertMany(batch, { ordered: false }).catch(() => {});
    batch = [];
  };
  for await (const business of Business.find({}).lean().cursor()) {
    if (evaluate(opportunity.criteria, business).label !== "Eligible") continue;
    batch.push({
      user: business.owner,
      type: "opportunity",
      title: `New opportunity: ${opportunity.title}`.slice(0, 120),
      body: "Your business meets the required requirements.",
      link,
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
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
