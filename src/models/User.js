import mongoose from "mongoose";

export const roles = ["msme_owner", "admin", "super_admin"];

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // Never returned by default. Only the login and password-change routes select it explicitly.
    passwordHash: { type: String, required: true, select: false },
    // Set only by the server: owners register themselves, admins are created by a super admin,
    // and the first super admin by the command-line script. A client can never choose a role.
    role: { type: String, enum: roles, default: "msme_owner" },
    // A deactivated account cannot log in and its sessions are removed.
    active: { type: Boolean, default: true },
    // Admins start with a temporary password and must replace it before doing anything else.
    mustChangePassword: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    failedLogins: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.failedLogins;
        delete ret.lockUntil;
        delete ret.createdBy;
        return ret;
      },
    },
  },
);

export const User = mongoose.models.User ?? mongoose.model("User", userSchema);
