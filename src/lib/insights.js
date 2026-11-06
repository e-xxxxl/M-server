import { profileFieldNames } from "../schemas.js";

/**
 * Dashboard insights computed from a business profile. These are plain facts about
 * what has and has not been filled in. There is deliberately no score or formula.
 */

const filled = (value) => (typeof value === "number" ? Number.isFinite(value) : typeof value === "string" ? value.trim() !== "" : false);

export function profileProgress(business) {
  const total = profileFieldNames.length;
  // Answering "No" to the CAC or TIN question completes that detail, just as entering the number does.
  const answeredNo = { cacNumber: business.hasCac === "No", tin: business.hasTin === "No" };
  const completed = profileFieldNames.filter((name) => filled(business[name]) || answeredNo[name] === true).length;
  return { completed, total };
}

/** Recommended next actions were removed. The list stays in the response, always empty, so earlier apps keep working. */
export const nextActions = () => [];

export function buildInsights(business) {
  return { progress: profileProgress(business), nextActions: [] };
}
