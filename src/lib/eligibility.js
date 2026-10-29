import * as o from "../options.js";

/**
 * Eligibility is a plain checklist: each requirement is met or not met. There is no hidden score.
 * "Required" requirements decide the label. "Preferred" ones are shown and counted in the
 * "N of M met" line but never block anyone.
 *
 * Kinds: "set" (the business value must be one of the listed values), "min" and "range" (numbers),
 * "yes" (the Yes or No answer must be Yes) and "verified" (the business must be verified).
 *
 * OR groups: requirements that share a `group` number are alternatives. The group is met when ANY one of them is met,
 * and it counts as ONE requirement in "N of M met" and in the label. Every member of a group has the same level.
 * Requirements without a group are all needed (AND), as before.
 */
const yearsIn = (business, now) => (Number.isFinite(business.yearEstablished) ? Math.max(0, now.getFullYear() - business.yearEstablished) : null);

export const criterionKinds = {
  sector: { kind: "set", label: "Sector", options: o.sectors, read: (b) => b.sector },
  state: { kind: "set", label: "State", options: o.states, read: (b) => b.state },
  businessType: { kind: "set", label: "Business type", options: o.businessTypes, read: (b) => b.businessType },
  annualRevenue: { kind: "set", label: "Annual revenue", options: o.annualRevenues, read: (b) => b.annualRevenue },
  yearsInBusiness: { kind: "min", label: "Years in business", read: yearsIn, max: 200 },
  employees: { kind: "range", label: "Number of employees", read: (b) => b.employees, max: 100000 },
  hasCac: { kind: "yes", label: "Registered with the CAC", read: (b) => b.hasCac || (b.cacNumber ? "Yes" : "") },
  hasTin: { kind: "yes", label: "Has a Tax Identification Number", read: (b) => b.hasTin || (b.tin ? "Yes" : "") },
  verified: { kind: "verified", label: "Verified business", read: (b) => b.verificationStatus },
};

export const criterionKeys = Object.keys(criterionKinds);

/** How many missing required requirements still count as "Nearly eligible". */
export const NEARLY_LIMIT = 2;

function requirementText(spec, c) {
  switch (spec.kind) {
    case "set":
      return c.values.join(" or ");
    case "min":
      return `${c.min} or more`;
    case "range":
      if (c.min !== undefined && c.max !== undefined) return `${c.min} to ${c.max}`;
      return c.min !== undefined ? `${c.min} or more` : `${c.max} or fewer`;
    case "yes":
      return "Yes";
    default:
      return "Verified";
  }
}

function isMet(spec, c, business, now) {
  const value = spec.read(business, now);
  switch (spec.kind) {
    case "set":
      return typeof value === "string" && c.values.includes(value);
    case "min":
      return typeof value === "number" && value >= c.min;
    case "range":
      return typeof value === "number" && (c.min === undefined || value >= c.min) && (c.max === undefined || value <= c.max);
    case "yes":
      return value === "Yes";
    default:
      return value === "Verified";
  }
}

const shown = (spec, value) => (value === null || value === undefined || value === "" ? "Not provided" : spec.kind === "verified" ? value : String(value));

/** Checks one business against an opportunity's criteria. */
export function evaluate(criteria, business, now = new Date()) {
  const checks = (criteria ?? []).map((c) => {
    const spec = criterionKinds[c.key];
    return {
      key: c.key,
      label: spec.label,
      level: c.level,
      group: c.group ?? null,
      requirement: requirementText(spec, c),
      yours: shown(spec, spec.read(business, now)),
      met: isMet(spec, c, business, now),
    };
  });
  // One unit per ungrouped requirement and one per OR group (met when any member is met).
  const units = [];
  const groups = new Map();
  for (const c of checks) {
    if (c.group === null) units.push({ level: c.level, met: c.met });
    else if (groups.has(c.group)) groups.get(c.group).met ||= c.met;
    else {
      const unit = { level: c.level, met: c.met };
      groups.set(c.group, unit);
      units.push(unit);
    }
  }
  const requiredMissing = units.filter((u) => u.level === "required" && !u.met).length;
  const met = units.filter((u) => u.met).length;
  const label = requiredMissing === 0 ? "Eligible" : requiredMissing <= NEARLY_LIMIT ? "Nearly eligible" : "Not eligible";
  return { checks, met, total: units.length, requiredMissing, label };
}

const labelRank = { Eligible: 0, "Nearly eligible": 1, "Not eligible": 2 };

/** Eligible first, then nearly eligible; more requirements met first; nearest deadline first. */
export function compareFit(a, b) {
  return (
    labelRank[a.fit.label] - labelRank[b.fit.label] ||
    b.fit.met - a.fit.met ||
    (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity)
  );
}
