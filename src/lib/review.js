import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { audit } from "../models/AuditLog.js";
import { notify } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { ApiError } from "../middleware/errors.js";
import { beneficiaryStatuses, reviewTransitions } from "./opportunity-constants.js";

/**
 * Moves an application to a new status. Used by platform admins and by the partner that owns the opportunity,
 * so the rules are the same for both: only the listed transitions, a note every time, and never more
 * approvals than the opportunity's number of beneficiaries.
 */
export async function applyReview(application, status, note, actor) {
  const allowed = reviewTransitions[application.status] ?? [];
  if (!allowed.includes(status)) {
    const message = allowed.length === 0 ? "This application is final and cannot be changed." : `Choose one of: ${allowed.join(", ")}.`;
    throw new ApiError(422, "validation", message, { status: message });
  }

  const opportunity = await Opportunity.findById(application.opportunity).select("title beneficiaryLimit");
  if (status === "Approved" && opportunity?.beneficiaryLimit) {
    const taken = await Application.countDocuments({
      opportunity: application.opportunity,
      status: mongoose.trusted({ $in: beneficiaryStatuses }),
    });
    if (taken >= opportunity.beneficiaryLimit) {
      const message = `This opportunity has reached its limit of ${opportunity.beneficiaryLimit} beneficiaries.`;
      throw new ApiError(422, "limit_reached", message, { status: message });
    }
  }

  application.status = status;
  application.history.push({ status, note });
  await application.save();

  await audit(actor, "application.status", `Set an application for "${opportunity?.title ?? "an opportunity"}" to ${status}`, {
    type: "application",
    id: application._id,
  });
  await notify(application.owner, {
    type: "application",
    title: `Application ${status.toLowerCase()}: ${opportunity?.title ?? "your application"}`.slice(0, 120),
    body: note.slice(0, 300),
    link: "/dashboard/applications/",
  });
  return application;
}
