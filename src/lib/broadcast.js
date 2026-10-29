import { Broadcast } from "../models/Broadcast.js";
import { sendNotificationEmail } from "./account-emails.js";
import { deliverPush } from "./push.js";

/**
 * Delivers a broadcast beyond the notification list: a push to every phone, and an email to each owner who has not
 * turned notification emails off. It runs in the background after the administrator's request has answered, because a
 * large audience takes a while (emails go out in batches of 100). Totals are written back to the broadcast.
 */

const inflight = new Set();

async function deliver({ owners, title, body, link, sendEmail, broadcastId }) {
  const pushesSent = await deliverPush(owners, { title, body, link, type: "announcement" });
  let emailsQueued = 0;
  if (sendEmail) {
    for (const owner of owners) {
      if (await sendNotificationEmail(owner, { title, body, link, bulk: true })) emailsQueued += 1;
    }
  }
  await Broadcast.updateOne({ _id: broadcastId }, { $set: { pushesSent, emailsQueued } });
}

/** Starts delivery and returns at once. The promise is kept so a test (or a shutdown) can wait for it. */
export function startBroadcastDelivery(args) {
  const run = deliver(args)
    .catch((err) => console.error("Broadcast delivery failed:", err?.name))
    .finally(() => inflight.delete(run));
  inflight.add(run);
  return run;
}

export const flushBroadcasts = () => Promise.all([...inflight]);
