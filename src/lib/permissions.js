/**
 * What each member of NMREP staff may do. A super admin can do everything. An administrator gets a set of permissions
 * chosen by the super admin when the account is made (and changed later), starting from the role's usual set:
 *
 * - "admin": everything an administrator does.
 * - "operations": look at everything (businesses, verification, payments, reports, applications, training) but change
 *   nothing and send nothing.
 *
 * The permissions are checked on the server for every request, so changing them takes effect on the next click.
 */

export const permissionKeys = ["verify", "payments", "export", "opportunities", "messages", "personal"];

export const permissionLabels = {
  verify: "Verify businesses (set a status, revoke or restore an account)",
  payments: "View payments",
  export: "Export data (spreadsheets)",
  opportunities: "Manage opportunities, applications, partners, training and referral codes",
  messages: "Send messages to owners and answer enquiries",
  personal: "See personal details (owner email, phone and uploaded documents)",
};

export const staffRoles = ["admin", "operations"];

export const rolePresets = {
  admin: [...permissionKeys],
  // Operations can look at everything, including payments and personal details, but cannot change or send anything.
  operations: ["payments", "personal"],
};

/** The permissions in force for a staff account (empty for anyone else). */
export function permissionsOf(user) {
  if (!user) return [];
  if (user.role === "super_admin") return [...permissionKeys];
  if (user.role !== "admin") return [];
  if (user.permissionsCustom) return permissionKeys.filter((key) => (user.permissions ?? []).includes(key));
  return [...(rolePresets[user.staffRole] ?? rolePresets.admin)];
}

export const can = (user, key) => permissionsOf(user).includes(key);

/** Express guard: the signed-in staff member must hold this permission. */
export const requirePermission = (key) => (req, res, next) => {
  if (can(req.user, key)) return next();
  res.status(403).json({ error: { code: "forbidden", message: "Your account is not allowed to do this. Ask a super admin to change your access." } });
};
