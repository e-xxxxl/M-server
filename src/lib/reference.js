import * as options from "../options.js";
import { applicationStatuses, opportunityTypes } from "./opportunity-constants.js";
import { sharingCategories } from "./sharing.js";

/** Bumped when a list changes in a way an app should notice. The app can cache the data and compare. */
export const REFERENCE_VERSION = 1;

/** Every list the API accepts or returns, in one place. */
export function referenceData() {
  return {
    version: REFERENCE_VERSION,
    businessTypes: options.businessTypes,
    sectors: options.sectors,
    states: options.states,
    ownerRoles: options.ownerRoles,
    ownershipStructures: options.ownershipStructures,
    annualRevenues: options.annualRevenues,
    existingLoans: options.existingLoans,
    fundingNeeds: options.fundingNeeds,
    yesNo: options.yesNo,
    verificationStatuses: options.verificationStatuses,
    opportunityTypes,
    applicationStatuses,
    sharingCategories: Object.entries(sharingCategories).map(([key, c]) => ({ key, label: c.label, required: c.required, description: c.description })),
  };
}
