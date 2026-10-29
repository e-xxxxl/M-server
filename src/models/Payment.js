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
        return ret;
      },
    },
  },
);

export const Payment = mongoose.models.Payment ?? mongoose.model("Payment", paymentSchema);
