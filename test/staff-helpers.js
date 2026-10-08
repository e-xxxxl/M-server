import { hashPassword } from "../src/lib/crypto.js";
import { User } from "../src/models/User.js";

let counter = 0;

/** Creates an admin or super admin straight in the database (the portal cannot create super admins). */
export async function createStaff({ role = "admin", password = "Staff12345", mustChangePassword = false, active = true } = {}) {
  counter += 1;
  const email = `staff${counter}-${Date.now()}@example.com`;
  const user = await User.create({
    fullName: `Staff Member ${counter}`,
    email,
    phone: "+234 800 000 0000",
    passwordHash: await hashPassword(password, 4),
    role,
    mustChangePassword,
    active,
  });
  return { user, email, password };
}

/** Logs in and returns the response, including the session cookie. */
export const logIn = (call, email, password) => call("POST", "/api/auth/login", { body: { email, password } });
