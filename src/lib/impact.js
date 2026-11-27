import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { ImpactEntry } from "../models/ImpactEntry.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { beneficiaryStatuses } from "./opportunity-constants.js";

/** The jobs a business reported, newest year first. */
export const entriesFor = (businessId) => ImpactEntry.find({ business: businessId }).sort({ year: -1 });

/**
 * What the platform itself knows about one business's impact: opportunities it was approved for, trainings it joined and
 * finished, certificates it earned, and the day it formalised (got a CAC number after joining NMREP).
 */
export async function derivedFor(business) {
  const [accessed, records] = await Promise.all([
    Application.countDocuments({ business: business._id, status: mongoose.trusted({ $in: beneficiaryStatuses }) }),
    TrainingRecord.find({ business: business._id }).select("completedAt certificate attendance").lean(),
  ]);
  return {
    opportunitiesAccessed: accessed,
    trainingsJoined: records.length,
    trainingsCompleted: records.filter((r) => r.completedAt).length,
    certificatesEarned: records.filter((r) => r.certificate?.code).length,
    formalisedAt: business.formalisedAt ?? null,
  };
}

/** The platform-wide impact figures for the admin reports. Counts and totals only: no business is named. */
export async function impactTotals() {
  const [jobsByYear, accessed, training, formalisedByYear, formalisedTotal] = await Promise.all([
    ImpactEntry.aggregate([{ $group: { _id: "$year", jobsCreated: { $sum: "$jobsCreated" }, businesses: { $sum: 1 } } }, { $sort: { _id: -1 } }]),
    Application.countDocuments({ status: mongoose.trusted({ $in: beneficiaryStatuses }) }),
    TrainingRecord.aggregate([
      {
        $group: {
          _id: null,
          joined: { $sum: 1 },
          completed: { $sum: { $cond: [{ $ne: ["$completedAt", null] }, 1, 0] } },
          certificates: { $sum: { $cond: [{ $ifNull: ["$certificate.code", false] }, 1, 0] } },
        },
      },
    ]),
    Business.aggregate([{ $match: { formalisedAt: { $ne: null } } }, { $group: { _id: { $year: "$formalisedAt" }, count: { $sum: 1 } } }, { $sort: { _id: -1 } }]),
    Business.countDocuments({ formalisedAt: mongoose.trusted({ $ne: null }) }),
  ]);
  const t = training[0] ?? { joined: 0, completed: 0, certificates: 0 };
  return {
    jobsCreatedByYear: jobsByYear.map((r) => ({ year: r._id, jobsCreated: r.jobsCreated, businessesReporting: r.businesses })),
    jobsCreatedTotal: jobsByYear.reduce((n, r) => n + r.jobsCreated, 0),
    opportunitiesAccessed: accessed,
    programmeAttendees: t.joined,
    programmeCompleted: t.completed,
    certificatesIssued: t.certificates,
    businessesFormalised: formalisedTotal,
    formalisedByYear: formalisedByYear.map((r) => ({ year: r._id, count: r.count })),
  };
}
