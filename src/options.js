// Allowed values for select fields. Keep in sync with src/content/registration.ts in the
// web app: test/options-sync.test.js fails if a value here is missing from that file.

export const states = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta",
  "Ebonyi", "Edo", "Ekiti", "Enugu", "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
  "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau",
  "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
];

export const businessTypes = [
  "Business name (sole owner or partnership)",
  "Private limited company",
  "Public limited company",
  "Limited liability partnership",
  "Incorporated trustees (association or NGO)",
  "Not yet registered with the CAC",
];

export const sectors = [
  "Agriculture and agro-processing",
  "Manufacturing",
  "Retail and trading",
  "Food and hospitality",
  "Fashion and textiles",
  "Technology and digital services",
  "Construction and real estate",
  "Transport and logistics",
  "Health and wellness",
  "Education and training",
  "Professional services",
  "Other",
];

export const ownerRoles = ["Owner", "Director", "Owner and director"];
export const ownershipStructures = ["Sole owner", "Partnership", "Shareholders", "Other"];

export const annualRevenues = [
  "Less than 5 million naira",
  "5 to 25 million naira",
  "25 to 100 million naira",
  "100 to 500 million naira",
  "More than 500 million naira",
];

export const existingLoans = ["No", "Yes"];

export const fundingNeeds = [
  "Not looking for funding now",
  "Less than 1 million naira",
  "1 to 5 million naira",
  "5 to 20 million naira",
  "More than 20 million naira",
];

export const verificationStatuses = ["Unverified", "Pending Verification", "Verified", "Rejected", "Suspended"];
