import { Router } from "express";
import mongoose from "mongoose";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { ApiError } from "../middleware/errors.js";
import { clearSessionCookie, requireAuth } from "../middleware/security.js";
import { accountPatchSchema, passwordChangeSchema } from "../schemas.js";

export function accountRoutes({ config, limiters }) {
  const router = Router();
  router.use(requireAuth(config));

  router.patch("/", async (req, res) => {
    const patch = accountPatchSchema.parse(req.body);
    Object.assign(req.user, patch);
    await req.user.save();
    res.json({ user: req.user });
  });

  router.post("/password", limiters.login, async (req, res) => {
    const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);
    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", {
        currentPassword: "Your current password is incorrect.",
      });
    }
    if (newPassword === currentPassword) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", {
        newPassword: "Choose a password different from your current one.",
      });
    }
    user.passwordHash = await hashPassword(newPassword, config.bcryptRounds);
    user.mustChangePassword = false; // a temporary password has now been replaced
    await user.save();
    // Sign out everywhere else. This device stays signed in.
    await Session.deleteMany({ user: user._id, _id: mongoose.trusted({ $ne: req.session._id }) });
    res.json({ ok: true, user });
  });

  // "Log out of all devices", including this one.
  router.delete("/sessions", async (req, res) => {
    await Session.deleteMany({ user: req.user._id });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
