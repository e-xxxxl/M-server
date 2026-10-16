// Values used by opportunities, applications, organisations and consent. Kept apart from options.js
// because options.js is compared with the website's registration form, and these are not registration choices.

export const opportunityTypes = ["Funding", "Grant", "Loan", "Training", "Support"];

/** Pending Approval is set only when a partner submits an opportunity for NMREP to approve. */
export const opportunityStatuses = ["Draft", "Pending Approval", "Open", "Closed"];
/** What a platform admin can set directly on the edit form. */
export const adminSettableStatuses = ["Draft", "Open", "Closed"];

export const criterionLevels = ["required", "preferred"];

/**
 * Application statuses. The framework document says "Rejected"; the API keeps the name "Declined"
 * (already published to the app developer), so Declined is the Rejected of the framework.
 */
export const applicationStatuses = [
  "Draft",
  "Submitted",
  "Screening",
  "Under Review",
  "More Information Required",
  "Approved",
  "Declined",
  "Waitlisted",
  "Withdrawn",
  "Completed",
];

/** What a reviewer (platform admin or the partner that owns the opportunity) may move an application to. */
export const reviewTransitions = {
  Submitted: ["Screening", "Under Review", "More Information Required", "Approved", "Declined", "Waitlisted"],
  Screening: ["Under Review", "More Information Required", "Approved", "Declined", "Waitlisted"],
  "Under Review": ["More Information Required", "Approved", "Declined", "Waitlisted"],
  Waitlisted: ["Approved", "Declined"],
  Approved: ["Completed"],
};

/** Statuses a reviewer can see. Drafts belong to the owner alone. */
export const reviewableStatuses = applicationStatuses.filter((s) => s !== "Draft");

/** An application the owner can still withdraw. */
export const withdrawable = ["Submitted", "Screening", "Under Review", "More Information Required", "Waitlisted"];

/** An application the owner can still edit or submit. More Information Required lets them answer the reviewer. */
export const editable = ["Draft", "Withdrawn", "More Information Required"];

/** Counted against an opportunity's number of beneficiaries. */
export const beneficiaryStatuses = ["Approved", "Completed"];

/**
 * Organisation types from the framework document. Training providers and funding partners have their own
 * tools planned for a later phase, so they cannot be created yet.
 */
export const organisationTypes = [
  "Government Ministry",
  "Government Agency",
  "Bank",
  "Microfinance Institution",
  "Development Finance Institution",
  "Business Association",
  "Private Sector Partner",
  "Training Provider",
  "Funding Partner",
];
export const organisationTypesAvailable = organisationTypes.filter((t) => t !== "Training Provider" && t !== "Funding Partner");
