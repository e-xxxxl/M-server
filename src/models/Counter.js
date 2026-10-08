import mongoose from "mongoose";

/** Atomic counters, used to issue NMREP Business IDs in sequence without duplicates. */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter = mongoose.models.Counter ?? mongoose.model("Counter", counterSchema);
