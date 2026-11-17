import mongoose from "mongoose";

/**
 * A Google Play subscription purchase that was confirmed with Google. The purchase token is unique: one purchase can
 * belong to one account only. The token is a secret of the buyer's, so it is never returned by any endpoint.
 */
const playSubscriptionSchema = new mongoose.Schema(
  {
    purchaseToken: { type: String, required: true, unique: true, maxlength: 2000 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    packageName: { type: String, required: true },
    productId: { type: String, required: true },
    basePlanId: { type: String, default: "" },
    orderId: { type: String, default: "" },
    // Google's own state name, such as SUBSCRIPTION_STATE_ACTIVE.
    state: { type: String, default: "" },
    expiresAt: { type: Date, default: null },
    autoRenewing: { type: Boolean, default: false },
    // Whether this purchase currently gives access.
    entitled: { type: Boolean, default: false },
    lastCheckedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

playSubscriptionSchema.index({ entitled: 1, expiresAt: 1 });

export const PlaySubscription = mongoose.models.PlaySubscription ?? mongoose.model("PlaySubscription", playSubscriptionSchema);
