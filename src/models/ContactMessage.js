import mongoose from "mongoose";

/**
 * A message sent from the contact form on the website. It is kept so staff can read and answer it even if the email to the
 * NMREP inbox is lost. Visitors are told never to put NIN, passwords or bank details in it.
 */
const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20, default: "" },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    handled: { type: Boolean, default: false, index: true },
    handledAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const ContactMessage = mongoose.models.ContactMessage ?? mongoose.model("ContactMessage", contactSchema);
