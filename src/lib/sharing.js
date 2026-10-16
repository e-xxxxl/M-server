/**
 * What an organisation can see about an applicant, and only after the owner agreed (framework sections 17 and 18).
 *
 * Three categories. "summary" is needed to apply. The other two are the owner's choice.
 * Nothing here covers NIN, BVN, bank account numbers, identity documents, statements or tax documents:
 * they are not collected in this version, and they would never be part of a default share.
 */
export const sharingCategories = {
  summary: {
    label: "Business summary",
    required: true,
    description:
      "Business name, trading name, business type, sector, what the business does, year established, state, LGA and city, ownership structure, number of employees, annual revenue band, whether it has a CAC registration and a TIN (Yes or No only), verification status and NMREP Business ID.",
    fields: [
      "businessName",
      "tradingName",
      "businessType",
      "sector",
      "industry",
      "yearEstablished",
      "state",
      "lga",
      "city",
      "ownershipStructure",
      "employees",
      "annualRevenue",
      "hasCac",
      "hasTin",
      "verificationStatus",
      "nmrepId",
    ],
  },
  contact: {
    label: "Owner contact details",
    required: false,
    description: "The owner's name, email address and phone number.",
    fields: [],
  },
  profile: {
    label: "Full business profile",
    required: false,
    description:
      "Business address, CAC and TIN numbers, owner role, number of branches, bank name, existing loans, funding needs, website and social media handles.",
    fields: ["address", "ownerName", "ownerRole", "cacNumber", "tin", "branches", "bankName", "existingLoans", "fundingNeeds", "website", "facebook", "instagram", "x", "tiktok"],
  },
};

export const categoryKeys = Object.keys(sharingCategories);

/** The description shown to the owner before they agree, for one opportunity. */
export function describeSharing(organisationName) {
  return {
    with: organisationName ?? "NMREP",
    categories: categoryKeys.map((key) => ({
      key,
      label: sharingCategories[key].label,
      required: sharingCategories[key].required,
      description: sharingCategories[key].description,
    })),
    neverShared: "Your NIN, BVN, bank account numbers, identity documents, bank statements and tax documents are not collected or shared.",
  };
}

const pick = (source, fields) => Object.fromEntries(fields.map((f) => [f, source?.[f] ?? null]));

/**
 * The applicant as an organisation may see them. `granted` is the list of categories the owner agreed to,
 * `snapshot` is the profile as it was at submission, `owner` is the owner's account.
 */
export function applicantView(snapshot, owner, granted) {
  const view = {};
  if (granted.includes("summary")) view.summary = pick(snapshot, sharingCategories.summary.fields);
  if (granted.includes("contact") && owner) view.contact = { fullName: owner.fullName, email: owner.email, phone: owner.phone };
  if (granted.includes("profile")) view.profile = pick(snapshot, sharingCategories.profile.fields);
  return view;
}
