/**
 * The business health profile: a plain checklist of facts about the business, grouped into areas.
 *
 * It is deliberately NOT a score. There is no percentage, no grade, no weighting and no "needs attention" colour,
 * because the framework gives no method for one and NMREP does not invent it. Every line is either done or not done,
 * and each area says "N of M". The framework's own example documents are listed so an owner can see what is in the wallet.
 */

import { documentKinds } from "../models/Document.js";

const filled = (v) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" ? v.trim() !== "" : false);

const SECTIONS = [
  { id: "identity", title: "Business identity", fields: ["businessName", "businessType", "sector", "industry", "yearEstablished"] },
  { id: "location", title: "Location", fields: ["state", "lga", "city", "address"] },
  { id: "ownership", title: "Ownership", fields: ["ownerName", "ownerRole", "ownershipStructure"] },
  // Only the details every owner must give count here. Branches, the bank and the size of opportunity are optional, so an
  // owner who leaves them blank is not left with a section that can never be complete.
  { id: "operations", title: "Operations", fields: ["employees"] },
  { id: "financial", title: "Financial", fields: ["annualRevenue", "existingLoans"] },
];

/** Every kind of wallet document except "Other", which has no meaning as a gap. */
export const walletChecklist = documentKinds.filter((k) => k !== "Other");

const verifiedHint = {
  Unverified: "NMREP staff review businesses. A complete profile helps the review.",
  "Pending Verification": "Your business is being reviewed. The status here updates when the review is complete.",
  Verified: "",
  Rejected: "Your last review was not approved. Check that your details are correct.",
  Suspended: "The status of your business is suspended. Please contact NMREP.",
};

const status = (done, total) => (done === total ? "Complete" : done === 0 ? "To do" : "In progress");

const area = (id, title, items) => {
  const done = items.filter((i) => i.done).length;
  return { id, title, done, total: items.length, summary: `${done} of ${items.length}`, status: status(done, items.length), items };
};

/**
 * @param business a business profile (plain object)
 * @param documentKinds the kinds of document the owner has in the wallet
 * @param productCount how many products and services the business has listed
 */
export function buildHealthProfile(business, documentKinds = [], productCount = 0) {
  const profile = (section) => ({ screen: "profile", section });
  const have = new Set(documentKinds);

  const registration = area("registration", "Registration", [
    {
      id: "registered",
      label: "Registered with the CAC",
      done: business.businessType !== "Not yet registered with the CAC",
      detail: "",
      hint: "Registered businesses are easier for organisations to check. Once registered, add your registration number.",
      link: profile("identity"),
    },
    { id: "cac", label: "CAC registration number added", done: filled(business.cacNumber), detail: "", hint: "Add your CAC registration number to your profile.", link: profile("identity") },
    { id: "tin", label: "Tax Identification Number (TIN) added", done: filled(business.tin), detail: "", hint: "Add your TIN to your profile.", link: profile("identity") },
  ]);

  const verification = area("verification", "Verification", [
    {
      id: "verified",
      label: "Business verified by NMREP",
      done: business.verificationStatus === "Verified",
      detail: business.verificationStatus,
      hint: verifiedHint[business.verificationStatus] ?? "",
      link: null,
    },
    { id: "nmrepId", label: "NMREP Business ID issued", done: filled(business.nmrepId), detail: "", hint: "The ID is issued the first time your business is verified.", link: null },
  ]);

  const information = area("information", "Business information", [
    ...SECTIONS.map((s) => {
      const done = s.fields.filter((f) => filled(business[f])).length;
      return {
        id: s.id,
        label: s.title,
        done: done === s.fields.length,
        detail: `${done} of ${s.fields.length} details`,
        hint: `Complete the ${s.title.toLowerCase()} details in your business profile.`,
        link: profile(s.id),
      };
    }),
    {
      id: "products",
      label: "Products and services listed",
      done: productCount > 0,
      detail: productCount > 0 ? `${productCount} listed` : "",
      hint: "List what your business sells on the Products page.",
      link: { screen: "products" },
    },
  ]);

  const documents = area(
    "documents",
    "Your documents",
    walletChecklist.map((kind) => ({
      id: kind.toLowerCase().replace(/[^a-z]+/g, "-"),
      label: kind,
      done: have.has(kind),
      detail: "",
      hint: "Add it on the Documents page, so you can attach it when an opportunity asks for it.",
      link: { screen: "documents" },
    })),
  );

  const areas = [registration, verification, information, documents];
  // The first few things not done, in the order of the areas. Not ranked by importance: there is no such method.
  // Recommended next steps were removed. The list stays in the response, always empty, so earlier apps keep working.
  const nextSteps = [];

  return {
    note: "A checklist of facts from your profile. It is not a score or a grade.",
    verificationStatus: business.verificationStatus,
    areas,
    nextSteps,
  };
}
