import { User } from "../models/User.js";
import { phoneKey } from "./phone-key.js";

export { looksLikePhone, phoneKey } from "./phone-key.js";

/** Gives every existing account its phone key. Safe to run on every start: it only touches accounts without one. */
export async function backfillPhoneKeys() {
  let done = 0;
  for await (const user of User.find({ $or: [{ phoneKey: { $exists: false } }, { phoneKey: "" }] }).select("phone").lean().cursor()) {
    await User.updateOne({ _id: user._id }, { $set: { phoneKey: phoneKey(user.phone) } });
    done += 1;
  }
  return done;
}
