/**
 * "How to become eligible": the steps between a business and an opportunity, in plain words, tied to the profile, the
 * verification and the document wallet. Built from the same checks the eligibility label comes from, so it can never
 * disagree with it. Only what is still missing is listed. Nothing here changes the label or ranks anyone.
 */

const PROFILE = "/dashboard/profile/";
const VERIFICATION = "/dashboard/verification/";
const DOCUMENTS = "/dashboard/documents/";

/** What to do about one unmet requirement. `changeable` is false for things an owner cannot honestly change. */
function stepFor(check) {
  const base = { key: check.key, level: check.level, requirement: check.requirement, yours: check.yours };
  switch (check.key) {
    case "hasCac":
      return { ...base, title: "Register with the Corporate Affairs Commission", detail: "Once the business is registered, add its CAC number to your profile and upload the certificate to your documents.", link: PROFILE };
    case "hasTin":
      return { ...base, title: "Get a Tax Identification Number", detail: "Once you have one, add it to your profile.", link: PROFILE };
    case "verified":
      return { ...base, title: "Get your business verified", detail: "Complete the verification steps. NMREP staff review what you send.", link: VERIFICATION };
    case "yearsInBusiness":
      return { ...base, title: `Be in business for ${check.requirement}`, detail: "If the year you started is wrong on your profile, correct it. Otherwise this one opens to you later.", link: PROFILE };
    default:
      return {
        ...base,
        title: `${check.label}: ${check.requirement}`,
        detail: check.yours === "Not provided" ? "Add this to your profile." : "If this is out of date on your profile, update it. If it is correct, this opportunity may not suit your business.",
        link: PROFILE,
      };
  }
}

/**
 * @param fit the result of evaluate()
 * @param documentsNeeded [{ kind, inWallet }]
 * @returns { ready, steps }, where each step is { type: "requirement" | "document", ... }
 */
export function howToQualify(fit, documentsNeeded = []) {
  const steps = [];
  const groups = new Map();
  for (const check of fit.checks) {
    if (check.met) continue;
    if (check.group === null) {
      steps.push({ type: "requirement", ...stepFor(check), anyOf: null });
      continue;
    }
    // A group is met when any member is; if one member is met none of its members are listed.
    if (!groups.has(check.group)) groups.set(check.group, []);
    groups.get(check.group).push(check);
  }
  for (const members of groups.values()) {
    const sameGroup = fit.checks.filter((c) => c.group === members[0].group);
    if (sameGroup.some((c) => c.met)) continue;
    const first = stepFor(members[0]);
    steps.push({
      type: "requirement",
      ...first,
      title: `Meet any one of these: ${members.map((m) => `${m.label} (${m.requirement})`).join("; ")}`,
      detail: first.detail,
      anyOf: members.map((m) => ({ key: m.key, label: m.label, requirement: m.requirement, yours: m.yours })),
    });
  }
  for (const doc of documentsNeeded) {
    if (doc.inWallet) continue;
    steps.push({ type: "document", key: doc.kind, level: "required", title: `Add your ${doc.kind}`, detail: "Keep it in your documents so you can attach it when you apply. You choose what is shared.", link: DOCUMENTS, requirement: doc.kind, yours: "Not in your documents", anyOf: null });
  }
  return { ready: steps.length === 0, steps };
}
