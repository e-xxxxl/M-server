import mongoose from "mongoose";

/**
 * Settings the super admin can change without a restart or a new deployment. One document, key "system", holding only
 * what has been changed: a missing value means "use the server's own setting" (the .env file). See lib/settings.js.
 */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    registrationFeeNaira: { type: Number, default: null },
    registrationPeriodDays: { type: Number, default: null },
    registrationFeeActive: { type: Boolean, default: null },
    // "alatpay" or "paystack". null: use the server's own choice (PAYMENT_GATEWAY, or the first configured gateway).
    paymentGateway: { type: String, enum: ["alatpay", "paystack", null], default: null },
    remindersEnabled: { type: Boolean, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export const Setting = mongoose.models.Setting ?? mongoose.model("Setting", settingSchema);
