import { Business } from "../models/Business.js";
import { notify } from "../models/Notification.js";
import { Opportunity } from "../models/Opportunity.js";
import { ReminderLog } from "../models/ReminderLog.js";
import { User } from "../models/User.js";
import mongoose from "mongoose";

/**
 * What happens when the yearly subscription runs out, and when an opportunity's closing date comes. These jobs run on
 * their own (see reminders.js): nobody has to press anything.
 */

const DAY = 24 * 60 * 60 * 1000;
const day = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });

/** Closes every opportunity that is still Open after its closing date. Returns how many were closed. */
export async function closeExpiredOpportunities(now = new Date()) {
  const res = await Opportunity.updateMany({ status: "Open", deadline: mongoose.trusted({ $lte: now }) }, { $set: { status: "Closed" } });
  return res.modifiedCount ?? 0;
}

/**
 * Suspends the business of every owner whose paid time ended and was not renewed. Only while the fee is on, and only for
 * owners who have paid before (an owner who never paid is held at the payment page already). The status it had is kept,
 * so renewing puts it back. Returns how many were suspended.
 */
export async function suspendLapsedSubscriptions(config, now = new Date()) {
  if (!config.payments.enabled) return 0;
  const owners = await User.find({ role: "msme_owner", active: true, registrationPaidUntil: mongoose.trusted({ $ne: null, $lt: now }) }).select("_id");
  let n = 0;
  for (const owner of owners) {
    const business = await Business.findOne({ owner: owner._id });
    if (!business || business.verificationStatus === "Suspended") continue;
    business.statusBeforeSuspension = business.verificationStatus;
    business.suspendedForSubscription = true;
    business.verificationStatus = "Suspended";
    business.verificationHistory.push({ status: "Suspended", at: now, note: "Subscription ended and was not renewed" });
    await business.save();
    await notify(owner._id, {
      type: "payment",
      title: "Your subscription has ended",
      body: "Your business is suspended until you renew. Renew your registration to restore your account.",
      link: "/pay/",
    });
    n += 1;
  }
  return n;
}

/** Called when a payment is recorded: a business suspended only because the subscription ended gets its status back. */
export async function restoreAfterRenewal(userId) {
  const business = await Business.findOne({ owner: userId, suspendedForSubscription: true });
  if (!business) return false;
  const back = business.statusBeforeSuspension && business.statusBeforeSuspension !== "Suspended" ? business.statusBeforeSuspension : "Unverified";
  business.verificationStatus = back;
  business.suspendedForSubscription = false;
  business.statusBeforeSuspension = "";
  business.verificationHistory.push({ status: back, at: new Date(), note: "Subscription renewed" });
  await business.save();
  return true;
}

/** Records a reminder once. Returns false when it was already sent. */
async function claim(owner, kind) {
  try {
    await ReminderLog.create({ owner, kind });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/**
 * Warns owners 14 days and again 3 days before their paid time ends. One reminder of each kind per end date, so renewing
 * (which moves the end date) earns a fresh set. Returns how many were sent.
 */
export async function runSubscriptionReminders(config, now = new Date()) {
  if (!config.payments.enabled) return 0;
  const owners = await User.find({
    role: "msme_owner",
    active: true,
    registrationPaidUntil: mongoose.trusted({ $gt: now, $lte: new Date(now.getTime() + 14 * DAY) }),
  }).select("registrationPaidUntil");
  let sent = 0;
  for (const owner of owners) {
    const until = owner.registrationPaidUntil;
    const kind = until.getTime() - now.getTime() <= 3 * DAY ? "3d" : "14d";
    if (!(await claim(owner._id, `sub:${until.toISOString().slice(0, 10)}:${kind}`))) continue;
    await notify(
      owner._id,
      {
        type: "payment",
        title: kind === "3d" ? "Your subscription ends in 3 days or less" : "Your subscription ends soon",
        body: `Your registration is paid until ${day(until)}. Renew before then, or your account will be suspended.`,
        link: "/pay/",
      },
      { bulk: true },
    );
    sent += 1;
  }
  return sent;
}
