import { Router } from "express";
import { currentSettings, updateSettings } from "../lib/settings.js";
import { audit } from "../models/AuditLog.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { settingsPatchSchema } from "../schemas.js";

const labels = {
  registrationFeeNaira: "registration fee amount",
  registrationPeriodDays: "registration period (days)",
  registrationFeeActive: "registration fee on or off",
  paymentGateway: "payment gateway",
  remindersEnabled: "reminders on or off",
};

/** System settings. Super admin only: the registration fee amount and period, pausing the fee, and the reminder job. */
export function adminSettingsRoutes({ config }) {
  const router = Router();
  router.use(requireAuth(config), requireRole("super_admin"), requirePasswordChanged);

  router.get("/", async (_req, res) => {
    res.json(await currentSettings(config));
  });

  router.patch("/", async (req, res) => {
    const patch = settingsPatchSchema.parse(req.body);
    const names = await updateSettings(config, patch, req.user);
    // The log says what was changed and to what. Nothing here is secret.
    const parts = names.map((n) => `${labels[n]}: ${patch[n] === null ? "back to the server default" : String(patch[n])}`);
    await audit(req.user, "settings.update", `Changed system settings (${parts.join("; ")})`, { type: "settings" });
    res.json(await currentSettings(config));
  });

  return router;
}
