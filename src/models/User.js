import mongoose from "mongoose";
import { phoneKey } from "../lib/phone-key.js";
import { permissionsOf } from "../lib/permissions.js";

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
    // Where the current paid time came from: "web" (ALATPay or Paystack), "google_play" or "app_store". Empty = web.
    subscriptionSource: { type: String, enum: ["", "web", "google_play", "app_store"], default: "" },
    subscriptionProductId: { type: String, default: "" },
    subscriptionAutoRenewing: { type: Boolean, default: false },
    // Staff only. "admin" or "operations", and what the account may do (see lib/permissions.js). While permissionsCustom is
    // false the role's usual set applies; when a super admin picks permissions by hand it is true and the list is used.
    staffRole: { type: String, enum: ["admin", "operations"], default: "admin" },
    permissionsCustom: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
    // Optional two-factor sign-in for staff (see lib/two-factor.js). The secret is stored encrypted, never in clear.
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: "", select: false },
    twoFactorLastStep: { type: Number, default: 0, select: false },
    twoFactorRecovery: { type: [String], default: [], select: false },
    // Whether to email and push notifications. Owners can turn either off; the in-app list always has them.
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        // What a staff account may do, worked out from its role and choices. Owners have none.
        if (doc.role === "admin" || doc.role === "super_admin") ret.permissions = permissionsOf(doc);
        else delete ret.permissions;
        if (doc.role !== "admin") delete ret.staffRole;
        delete ret.permissionsCustom;
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
        delete ret.twoFactorSecret;
        delete ret.twoFactorLastStep;
        delete ret.twoFactorRecovery;
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
