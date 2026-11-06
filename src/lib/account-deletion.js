import { documentStorage } from "./document-storage.js";
import { Application } from "../models/Application.js";
import { Business } from "../models/Business.js";
import { ConsentRecord } from "../models/ConsentRecord.js";
import { Device } from "../models/Device.js";
import { Document } from "../models/Document.js";
import { DocumentAccess } from "../models/DocumentAccess.js";
import { EmailToken } from "../models/EmailToken.js";
import { Notification } from "../models/Notification.js";
import { Product } from "../models/Product.js";
import { Session } from "../models/Session.js";
import { TrainingRecord } from "../models/TrainingRecord.js";
import { User } from "../models/User.js";
import { VerificationCheck } from "../models/VerificationCheck.js";
import { VerificationSubmission } from "../models/VerificationSubmission.js";

/**
 * Deletes an owner's account and everything personal that belongs to it: applications, notifications, documents (the
 * files are removed from the disk, not only the records), products and their pictures, verification checks, devices,
 * training records, sessions, the business and the user. Used when an owner deletes their own account and when the
 * super admin permanently deletes one, so the two can never drift apart.
 *
 * Kept on purpose: consent records (ended, with no profile data) as an accountability record of what was shared, payment
 * records (accounting), and the activity log. Returns how many of each thing was removed.
 */
export async function deleteOwnerData(user, { reason = "Account deleted" } = {}) {
  const counts = {};
  const removed = async (name, run) => {
    counts[name] = (await run()).deletedCount ?? 0;
  };

  await removed("applications", () => Application.deleteMany({ owner: user._id }));
  await removed("notifications", () => Notification.deleteMany({ user: user._id }));
  await EmailToken.deleteMany({ user: user._id });

  const documents = await Document.find({ owner: user._id }).select("storageKey");
  for (const doc of documents) await documentStorage.remove(doc.storageKey);
  await removed("documents", () => Document.deleteMany({ owner: user._id }));
  await DocumentAccess.deleteMany({ owner: user._id });

  const products = await Product.find({ owner: user._id });
  for (const product of products) for (const image of product.images ?? []) await documentStorage.remove(image.storageKey);
  await removed("products", () => Product.deleteMany({ owner: user._id }));

  await removed("verificationChecks", () => VerificationCheck.deleteMany({ owner: user._id }));
  await VerificationSubmission.deleteMany({ owner: user._id });
  await Device.deleteMany({ user: user._id });
  await removed("trainingRecords", () => TrainingRecord.deleteMany({ owner: user._id }));
  await ConsentRecord.updateMany({ owner: user._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  await Session.deleteMany({ user: user._id });
  const mine = await Business.findOne({ owner: user._id }).select("logo");
  if (mine?.logo?.storageKey) await documentStorage.remove(mine.logo.storageKey);
  await Business.deleteOne({ owner: user._id });
  await User.deleteOne({ _id: user._id });
  return counts;
}
