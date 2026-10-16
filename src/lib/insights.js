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

export function nextActions(business) {
  const actions = [];
  const unregistered = business.businessType === "Not yet registered with the CAC";

  if (business.hasCac !== "No" && !filled(business.cacNumber)) {
    actions.push(
      unregistered
        ? {
            id: "cac",
            title: "Register your business with the CAC",
            description: "Once registered, add your registration number to your profile. Registered businesses are easier to verify.",
            section: "identity",
          }
        : {
            id: "cac",
            title: "Add your CAC registration number",
            description: "Registered businesses are easier for partners to verify.",
            section: "identity",
          },
    );
  }
  if (business.hasTin !== "No" && !filled(business.tin)) {
    actions.push({
      id: "tin",
      title: "Add your Tax Identification Number (TIN)",
      description: "Lenders and larger customers often ask for it.",
      section: "identity",
    });
  }
  if (!filled(business.bankName)) {
    actions.push({
      id: "bank",
      title: "Add the bank your business uses",
      description: "Banking information is part of a complete business profile.",
      section: "financial",
    });
  }
  if (!filled(business.fundingNeeds)) {
    actions.push({
      id: "funding",
      title: "Tell us the funding you are looking for",
      description: "It helps show which opportunities fit your business.",
      section: "financial",
    });
  }
  if (business.branches === null || business.branches === undefined) {
    actions.push({
      id: "branches",
      title: "Add your number of branches",
      description: "Enter 0 if your business operates from one location.",
      section: "operations",
    });
  }
  if (!["website", "facebook", "instagram", "x", "tiktok"].some((k) => filled(business[k]))) {
    actions.push({
      id: "digital",
      title: "Add your website or social media handles",
      description: "Your digital presence is part of your business profile.",
      section: "digital",
    });
  }
  return actions;
}

export function buildInsights(business) {
  return { progress: profileProgress(business), nextActions: nextActions(business) };
}
