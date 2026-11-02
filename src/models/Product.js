import mongoose from "mongoose";

export const productKinds = ["Product", "Service"];
/** How many products and services one business can list. */
export const MAX_PRODUCTS = 30;
/** Pictures per product, and the largest one. They are stored encrypted, like the document wallet. */
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * A product or service the business sells. Part of the business profile (data collection module 6): what it is, a price
 * in naira, how much the business can supply, and whether it is ready for export, with up to three pictures.
 */
const productSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    kind: { type: String, enum: productKinds, required: true },
    name: { type: String, required: true, maxlength: 100 },
    category: { type: String, default: "", maxlength: 60 },
    description: { type: String, default: "", maxlength: 500 },
    /** In naira. null when the owner does not give a price. */
    unitPrice: { type: Number, default: null, min: 0, max: 10_000_000_000 },
    /** What the price is for, for example "per bag" or "per hour". */
    priceUnit: { type: String, default: "", maxlength: 30 },
    /** How much the business can supply, in words, for example "500 bags a month". */
    capacity: { type: String, default: "", maxlength: 120 },
    exportReady: { type: Boolean, default: false },
    // The picture files are encrypted in the private document folder. Only facts about them are kept here.
    images: [
      {
        mime: { type: String, enum: ["image/jpeg", "image/png"], required: true },
        size: { type: Number, required: true },
        storageKey: { type: String, required: true },
        iv: { type: String, required: true },
        tag: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.owner;
        delete ret.business;
        // Never the storage details: only what a screen needs to ask for the picture.
        ret.images = (ret.images ?? []).map((i) => ({ id: String(i._id), mime: i.mime, size: i.size }));
        return ret;
      },
    },
  },
);

export const Product = mongoose.models.Product ?? mongoose.model("Product", productSchema);
