import { Business } from "../models/Business.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { annualRevenues } from "../options.js";

const named = (rows) => rows.map((r) => ({ name: r._id || "Not set", count: r.count }));
const group = (field) => [{ $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }];

// Bands are plain counts of people and years. They are not an official size class: NMREP does not state one.
const employeeBands = [
  { from: 0, label: "0 to 9 employees" },
  { from: 10, label: "10 to 49 employees" },
  { from: 50, label: "50 to 199 employees" },
  { from: 200, label: "200 or more employees" },
];
const ageBands = [
  { from: 0, label: "Under 1 year" },
  { from: 1, label: "1 to 2 years" },
  { from: 3, label: "3 to 5 years" },
  { from: 6, label: "6 to 10 years" },
  { from: 11, label: "More than 10 years" },
];

/** A $bucket over a numeric expression into the labelled bands, empty bands included so the order never changes. */
async function banded(expression, bands) {
  const rows = await Business.aggregate([
    { $bucket: { groupBy: expression, boundaries: [...bands.map((b) => b.from), Number.MAX_SAFE_INTEGER], default: "other", output: { count: { $sum: 1 } } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id, r.count]));
  return bands.map((b) => ({ name: b.label, count: counts.get(b.from) ?? 0 }));
}

/**
 * How the registered businesses are distributed, for the admin reports. Counts only: no business is named. The local
 * government area is free text, so it is grouped together with its state and may split a place spelt two ways.
 */
export async function businessBreakdowns(now = new Date()) {
  const thisYear = now.getUTCFullYear();
  const [lga, businessType, revenue, employees, age, jobs] = await Promise.all([
    Business.aggregate([{ $group: { _id: { state: "$state", lga: "$lga" }, count: { $sum: 1 } } }, { $sort: { count: -1, "_id.state": 1, "_id.lga": 1 } }, { $limit: 25 }]),
    Business.aggregate(group("$businessType")),
    Business.aggregate(group("$annualRevenue")),
    banded("$employees", employeeBands),
    banded({ $max: [0, { $subtract: [thisYear, "$yearEstablished"] }] }, ageBands),
    Business.aggregate([{ $group: { _id: null, total: { $sum: "$employees" } } }]),
  ]);
  const revenueByName = new Map(named(revenue).map((r) => [r.name, r.count]));
  return {
    byLga: lga.map((r) => ({ name: `${r._id.lga || "Not set"}, ${r._id.state || "Not set"}`, count: r.count })),
    byBusinessType: named(businessType),
    // In the order of the choices on the form, with the empty ones shown, so the chart reads from small to large.
    byAnnualRevenue: [...annualRevenues.map((name) => ({ name, count: revenueByName.get(name) ?? 0 })), ...named(revenue).filter((r) => !annualRevenues.includes(r.name))],
    byEmployees: employees,
    byBusinessAge: age,
    totalEmployees: jobs[0]?.total ?? 0,
  };
}

/** Participants and results for the given trainings (all when `opportunityIds` is null). */
export async function trainingStats(opportunityIds = null) {
  const match = opportunityIds ? { opportunity: { $in: opportunityIds } } : {};
  const [row] = await TrainingRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        participants: { $sum: 1 },
        completed: { $sum: { $cond: [{ $ne: ["$completedAt", null] }, 1, 0] } },
        certificates: { $sum: { $cond: [{ $ifNull: ["$certificate.code", false] }, 1, 0] } },
        passed: { $sum: { $cond: [{ $eq: ["$assessment.result", "Passed"] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$assessment.result", "Failed"] }, 1, 0] } },
      },
    },
  ]);
  const t = row ?? { participants: 0, completed: 0, certificates: 0, passed: 0, failed: 0 };
  return { participants: t.participants, completed: t.completed, certificatesIssued: t.certificates, passed: t.passed, failed: t.failed };
}
