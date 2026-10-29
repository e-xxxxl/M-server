import mongoose from "mongoose";
import { phoneKey } from "../lib/phone-key.js";

export const roles = ["msme_owner", "admin", "super_admin", "partner"];

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // The phone number as digits in one shape (see lib/phone.js). Lets someone sign in with their number.
    phoneKey: { type: String, default: "", index: true },
    // Never returned by default. Only the login and password-change routes select it explicitly.
    passwordHash: { type: String, required: true, select: false },
    // Set only by the server: owners register themselves, admins are created by a super admin,
    // and the first super admin by the command-line script. A client can never choose a role.
    role: { type: String, enum: roles, default: "msme_owner" },
    // Partners belong to one organisation and can only ever see that organisation's data.
    organisation: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", default: null },
    // A deactivated account cannot log in and its sessions are removed.
    active: { type: Boolean, default: true },
    // Admins start with a temporary password and must replace it before doing anything else.
    mustChangePassword: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null },
    // Set when the person opens the link in the confirmation email.
    emailVerifiedAt: { type: Date, default: null },
    // The yearly registration fee: the day the paid registration ends. null = never paid.
    registrationPaidUntil: { type: Date, default: null },
    // Whether to email and push notifications. Owners can turn either off; the in-app list always has them.
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        if (ret.organisation) ret.organisation = String(ret.organisation);
        else delete ret.organisation;
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.failedLogins;
        delete ret.lockUntil;
        delete ret.createdBy;
        delete ret.phoneKey;
        return ret;
      },
    },
  },
);

// Keep the phone key in step with the phone number.
userSchema.pre("validate", function setPhoneKey() {
  if (this.isModified("phone") || !this.phoneKey) this.phoneKey = phoneKey(this.phone);
});

export const User = mongoose.models.User ?? mongoose.model("User", userSchema);
