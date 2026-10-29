import mongoose from "mongoose";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { Opportunity } from "../models/Opportunity.js";
import { notify } from "../models/Notification.js";
import { Organisation } from "../models/Organisation.js";
import { ReminderLog } from "../models/ReminderLog.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { User } from "../models/User.js";
import { evaluate } from "./eligibility.js";

/**
 * Reminders that need a clock: a programme closing soon, and a training session tomorrow. Each reminder is recorded in
 * ReminderLog under a unique key, so running the job twice (or on two servers at once) never sends one twice.
 * Reminders are notifications like any other: in the app, on the phone and, unless the owner turned it off, by email.
 */

const DAY = 24 * 60 * 60 * 1000;
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" });

/** Records the reminder and returns true when it is new. A duplicate (same opportunity, owner and kind) returns false. */
async function claim(opportunity, owner, kind) {
  try {
    await ReminderLog.create({ opportunity, owner, kind });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/** Active owners as a Set of user ids, so a revoked account is never reminded. */
async function inactiveOwnerIds() {
  return new Set((await User.find({ role: "msme_owner", active: false }).distinct("_id")).map(String));
}

/**
 * Tells owners who could still apply that a programme closes in 3 days, and again in 1 day. Only owners whose business
 * is Eligible and who have no application, or only a draft, are told. Returns how many reminders were sent.
 */
export async function runDeadlineReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + 3 * DAY);
  const opportunities = await Opportunity.find({ status: "Open", archivedAt: null, deadline: mongoose.trusted({ $gt: now, $lte: horizon }) });
  if (opportunities.length === 0) return 0;
  const inactive = await inactiveOwnerIds();
  let sent = 0;

  for (const opportunity of opportunities) {
    if (!opportunity.isAcceptingApplications(now)) continue;
    if (opportunity.organisation && !(await Organisation.exists({ _id: opportunity.organisation, active: true }))) continue;
    const kind = opportunity.deadline.getTime() - now.getTime() <= DAY ? "deadline-1d" : "deadline-3d";
    const left = kind === "deadline-1d" ? "tomorrow" : "in 3 days";
    const applied = new Map((await Application.find({ opportunity: opportunity._id }).select("owner status")).map((a) => [String(a.owner), a.status]));

    for await (const business of Business.find({}).select("owner sector state businessType annualRevenue yearEstablished employees hasCac cacNumber hasTin tin verificationStatus").lean().cursor()) {
      const owner = String(business.owner);
      if (inactive.has(owner)) continue;
      const status = applied.get(owner);
      if (status && status !== "Draft") continue;
      if (evaluate(opportunity.criteria, business, now).label !== "Eligible") continue;
      if (!(await claim(opportunity._id, business.owner, kind))) continue;
      await notify(business.owner, {
        type: "opportunity",
        title: `"${opportunity.title}" closes ${left}`.slice(0, 120),
        body: status === "Draft" ? `You have a draft. The last day to apply is ${day(opportunity.deadline)}.` : `Your business is eligible. The last day to apply is ${day(opportunity.deadline)}.`,
        link: `/dashboard/opportunities/detail/?id=${opportunity._id}`,
      }, { bulk: true });
      sent += 1;
    }
  }
  return sent;
}

/** Tells registered participants the day before a training session. Returns how many reminders were sent. */
export async function runSessionReminders(now = new Date()) {
  const trainings = await Opportunity.find({ type: "Training", archivedAt: null, "training.sessions.on": mongoose.trusted({ $gt: now, $lte: new Date(now.getTime() + DAY) }) });
  if (trainings.length === 0) return 0;
  const inactive = await inactiveOwnerIds();
  let sent = 0;

  for (const training of trainings) {
    for (const session of training.training?.sessions ?? []) {
      // The session day starts at midnight in Nigeria, so "the day before" is the 24 hours leading up to it.
      if (!(session.on > now && session.on.getTime() - now.getTime() <= DAY)) continue;
      for (const record of await TrainingRecord.find({ opportunity: training._id }).select("owner")) {
        if (inactive.has(String(record.owner))) continue;
        if (!(await claim(training._id, record.owner, `session:${session._id}`))) continue;
        await notify(record.owner, {
          type: "opportunity",
          title: `Training session tomorrow: ${training.title}`.slice(0, 120),
          body: `${session.title} on ${day(session.on)}${training.training.venue ? ` at ${training.training.venue}` : ""}.`.slice(0, 300),
          link: "/dashboard/training/",
        }, { bulk: true });
        sent += 1;
      }
    }
  }
  return sent;
}

/** One pass of every reminder job. Never throws: a failure is logged by name only and the next pass tries again. */
export async function runReminders(now = new Date()) {
  try {
    return { deadlines: await runDeadlineReminders(now), sessions: await runSessionReminders(now) };
  } catch (err) {
    console.error("Reminder job failed:", err?.name);
    return { deadlines: 0, sessions: 0, failed: true };
  }
}

/** Starts the reminder job: a first pass a minute after start, then every `intervalMinutes`. Returns a function that stops it. */
export function startReminderScheduler({ intervalMinutes = 60 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminders();
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, Math.max(1, intervalMinutes) * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
