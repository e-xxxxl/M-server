// Values used by opportunities, applications, organisations and consent. Kept apart from options.js
// because options.js is compared with the website's registration form, and these are not registration choices.

export const opportunityTypes = ["Funding", "Grant", "Loan", "Training", "Support"];

/**
 * Categories from the framework (section 8), as tags on top of the type: an opportunity has one type and up to
 * `maxOpportunityTags` tags. Funding, grants, loans and training are types, so they are not repeated here.
 */
export const opportunityTagGroups = [
  { group: "Funding", tags: ["Equity", "Equipment financing"] },
  { group: "Skills and growth", tags: ["Digital marketing", "Accounting", "Export", "Leadership", "Technology"] },
  { group: "Government programmes", tags: ["MSME support", "Sector programme", "State programme"] },
  { group: "Business services", tags: ["Legal", "Logistics", "Insurance"] },
];
export const opportunityTags = opportunityTagGroups.flatMap((g) => g.tags);
export const maxOpportunityTags = 5;

/** Documents an opportunity can ask for (every wallet kind except "Other"), and the most it can ask for. */
export const maxRequiredDocuments = 6;
/** Questions an opportunity can ask the applicant, and the longest answer. */
export const maxQuestions = 8;
export const maxAnswerLength = 500;

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
 * Organisation types from the framework document. Training providers have the training tools (see lib/training.js).
 * Funding partners have their own tools planned for a later phase, so they cannot be created yet.
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
export const organisationTypesAvailable = organisationTypes.filter((t) => t !== "Funding Partner");

/** How a training is delivered. */
export const trainingModes = ["In person", "Online", "Hybrid"];

/** What an assessment can say. A training without an assessment simply has none recorded. */
export const assessmentResults = ["Passed", "Failed"];
