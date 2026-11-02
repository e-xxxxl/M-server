import { Setting } from "../models/Setting.js";

/**
 * System settings the super admin can change from the admin portal. The server's own settings (.env) are the starting
 * point; what the super admin changes is stored in the database and laid over them, on the live config object, so a
 * change takes effect at once and survives a restart. A value of null means "use the .env value again".
 *
 * Secrets are never part of this: the Paystack key stays in .env, and nothing here can reveal it.
 */

const KEY = "system";
const defaultsOf = new WeakMap();

/** What the .env file says, remembered before anything is laid over it. */
function envDefaults(config) {
  if (!defaultsOf.has(config)) {
    defaultsOf.set(config, {
      registrationFeeNaira: config.payments.registrationFeeNaira,
      registrationPeriodDays: config.payments.periodDays,
      registrationFeeActive: true,
      remindersEnabled: config.reminders.enabled,
    });
  }
  return defaultsOf.get(config);
}

/** Lays the stored changes over the live config. Returns the settings now in force. */
export function applyToConfig(config, stored = {}) {
  const base = envDefaults(config);
  const pick = (name) => (stored[name] === null || stored[name] === undefined ? base[name] : stored[name]);
  config.payments.registrationFeeNaira = pick("registrationFeeNaira");
  config.payments.periodDays = pick("registrationPeriodDays");
  // The fee needs a Paystack key AND not to be paused. Pausing never needs the key to be removed.
  config.payments.enabled = Boolean(config.payments.secretKey) && pick("registrationFeeActive");
  config.reminders.enabled = pick("remindersEnabled");
}

/** Reads the stored changes once at start. Safe to call again. */
export async function loadSettings(config) {
  const doc = await Setting.findOne({ key: KEY }).lean();
  applyToConfig(config, doc ?? {});
}

/** The settings as shown to the super admin: the value in force, the value from .env, and whether it was changed. */
export async function currentSettings(config) {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const base = envDefaults(config);
  const changed = (name) => doc?.[name] !== null && doc?.[name] !== undefined;
  const secretKey = config.payments.secretKey;
  return {
    registrationFee: {
      amountNaira: config.payments.registrationFeeNaira,
      periodDays: config.payments.periodDays,
      active: changed("registrationFeeActive") ? doc.registrationFeeActive : true,
      // Whether a Paystack key is set on the server, and which kind. The key itself is never sent anywhere.
      keySet: Boolean(secretKey),
      keyMode: secretKey ? (secretKey.startsWith("sk_live_") ? "live" : "test") : null,
      // True when owners are really being asked to pay right now.
      inForce: config.payments.enabled,
      envAmountNaira: base.registrationFeeNaira,
      envPeriodDays: base.registrationPeriodDays,
      amountChanged: changed("registrationFeeNaira"),
      periodChanged: changed("registrationPeriodDays"),
    },
    reminders: { enabled: config.reminders.enabled, envEnabled: base.remindersEnabled, changed: changed("remindersEnabled") },
    updatedAt: doc?.updatedAt ?? null,
  };
}

/**
 * Saves a change. `patch` holds only the settings to change; null puts one back to the .env value. Returns the names that
 * changed, for the activity log.
 */
export async function updateSettings(config, patch, actor) {
  const set = {};
  const names = [];
  for (const name of ["registrationFeeNaira", "registrationPeriodDays", "registrationFeeActive", "remindersEnabled"]) {
    if (patch[name] !== undefined) {
      set[name] = patch[name];
      names.push(name);
    }
  }
  const doc = await Setting.findOneAndUpdate({ key: KEY }, { $set: { ...set, updatedBy: actor?._id ?? null } }, { upsert: true, returnDocument: "after" }).lean();
  applyToConfig(config, doc);
  return names;
}
