import mongoose from "mongoose";

export const devicePlatforms = ["ios", "android"];

/**
 * A phone that can receive push notifications for an account. The token comes from the app (an Expo push token) and is
 * the only thing kept besides the platform. A token belongs to one account at a time: when someone signs in on the same
 * phone, the token moves to them.
 */
const deviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true, maxlength: 200 },
    platform: { type: String, enum: devicePlatforms, required: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.user;
        return ret;
      },
    },
  },
);

export const Device = mongoose.models.Device ?? mongoose.model("Device", deviceSchema);
