import mongoose from "mongoose";

export const paymentStatuses = ["pending", "success", "failed"];

/**
 * One payment attempt. Only the facts the server needs are kept: who paid, how much, the reference and the outcome.
 * Card details never reach NMREP: the payer enters them on Paystack's own page.
 */
const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reference: { type: String, required: true, unique: true, maxlength: 80 },
    // The gateway that took (or is taking) this payment, and its own id for it (ALATPay's transactionId).
    provider: { type: String, enum: ["paystack", "alatpay"], default: "paystack" },
    providerRef: { type: String, default: undefined, maxlength: 80, index: true, sparse: true },
    // ALATPay only: where to transfer the money. A virtual account is good for 24 hours.
    transfer: {
      bankCode: { type: String, default: undefined },
      accountNumber: { type: String, default: undefined },
      expiresAt: { type: Date, default: undefined },
    },
    purpose: { type: String, enum: ["registration"], default: "registration" },
    amountKobo: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    status: { type: String, enum: paymentStatuses, default: "pending" },
    paidAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        ret.amount = ret.amountKobo / 100;
        delete ret._id;
        delete ret.__v;
        delete ret.user;
        delete ret.amountKobo;
        delete ret.providerRef;
        delete ret.transfer;
        return ret;
      },
    },
  },
);

export const Payment = mongoose.models.Payment ?? mongoose.model("Payment", paymentSchema);
