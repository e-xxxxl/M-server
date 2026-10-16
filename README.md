# NMREP API

The server side of NMREP: accounts, login sessions, business profiles and the data behind the dashboard. Node.js, Express 5 and MongoDB (Mongoose).

The website (the Next.js app in the folder above) is a static site on shared hosting. It calls this API from the browser.

## Run it

1. Install: `cd backend && npm install`
2. Copy `.env.example` to `.env` and set `MONGODB_URI` to your MongoDB connection string (include the database name, for example `.../nmrep?retryWrites=true&w=majority`).
3. Start: `npm start` (or `npm run dev` to restart on changes). It listens on port 4000.
4. In the web app folder run `npm run dev`. The site on http://localhost:3000 talks to http://localhost:4000.

No MongoDB yet? `npm run dev:memory` starts the API against a temporary in-memory database so you can try registration and the dashboard. The data disappears when you stop it. The first run downloads a MongoDB program once (hundreds of MB).

Check it works: open http://localhost:4000/api/health. You should see `{"status":"ok","database":true}`.

## Environment variables

| Name | Meaning |
|---|---|
| `MONGODB_URI` | Required. Connection string. A secret: keep it in `.env` or the host's settings, never in git. |
| `PORT` | Port to listen on. Default 4000. |
| `NODE_ENV` | `production` on the live server. Makes cookies HTTPS-only. |
| `CORS_ORIGINS` | Websites allowed to call the API, comma separated, no trailing slash. Production: `https://nmrep.ng`. |
| `TRUST_PROXY` | Number of proxies in front of the API. Default 1 in production (Render). |
| `SESSION_TTL_DAYS` | Login length. Default 7. |
| `COOKIE_SAMESITE`, `COOKIE_DOMAIN` | Leave unset when the site is `nmrep.ng` and the API is `api.nmrep.ng`. |
| `HOST` | Address to listen on. Default all addresses (Render). On the VPS use `127.0.0.1` so only nginx can reach the API. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Email through Resend. Both the key and the sender are needed, otherwise email is off (everything else still works). The sender's domain must be verified in Resend. The key is a secret: only in the real `.env`. |
| `APP_URL` | The website's address, for the links in emails. No trailing slash. |
| `EMAIL_NOTIFICATIONS` | Default `true`: also email owners about verification and application decisions. `false` sends only reset and confirmation emails. |
| `RATE_LIMIT_RESET` | Limit per IP and 15 minutes for the forgot password, reset password, confirm email and resend endpoints. Default 10. |
| `APP_SESSION_TTL_DAYS`, `APP_SESSION_MAX_DAYS` | Mobile app sessions (requests with `X-Client: app`). The session stays valid while the app is used: default 30 days from the last use, never more than 90 days after the login. |
| `ALLOW_TOKEN_AUTH` | **Legacy, testing only.** `true` makes login and registration return the session token to browsers as well, and lets the API accept it as `Authorization: Bearer <token>` without `X-Client: app`. Use it only while the site and the API are on unrelated domains (browsers block the cookie there). The token sits in browser storage that scripts can read, so it is weaker than the cookie: **turn it off for production**. The server prints a warning at start when it is on. The mobile app does not need it. |

## API documentation for app developers

The single source of truth is `docs/api/` at the root of the repository: start with `docs/api/README.md`. The older `API.md` and `API-QUICK-GUIDE.md` in this folder only point there.

## Deploying

- **On your own server (VPS):** follow [DEPLOY-VPS.md](DEPLOY-VPS.md). It covers securing the server, MongoDB with passwords, nginx and HTTPS, email through Resend, backups and updates. The service, nginx, deploy and backup files are in `deploy/`.
- **On Render:** the steps below.

## Deploying on Render

1. Create a Web Service from this repository with the root directory set to `backend`. Build command `npm install`, start command `npm start`.
2. Set the environment variables above (`MONGODB_URI`, `NODE_ENV=production`, `CORS_ORIGINS=https://nmrep.ng`).
3. In MongoDB Atlas allow the host's outgoing addresses in Network Access.
4. Attach the custom domain `api.nmrep.ng` to the service and point a CNAME to it. **Use a subdomain of nmrep.ng.** The login cookie is `SameSite=Lax`, which browsers send between `nmrep.ng` and `api.nmrep.ng` (same site) but not between unrelated domains such as `onrender.com` and `nmrep.ng`.
5. Rebuild the website with `NEXT_PUBLIC_API_URL=https://api.nmrep.ng` (this is already the production default) and upload it.

## First super admin

Staff accounts use the same login page as business owners. The first super admin cannot be created through the website (that would be a hole), so create it on the API host once:

```bash
npm run create-super-admin
```

It asks for a name, email, phone and a password (hidden while you type, at least 8 characters with a letter and a number; use a much longer one for a super admin). For automation set `SUPER_ADMIN_NAME`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PHONE` and `SUPER_ADMIN_PASSWORD` instead. It refuses an email that already exists. After that, the super admin logs in at `/login/` and is taken to `/admin/`, where they create admins (each gets a one-time temporary password and must choose their own on first login) and referral codes.

## Roles

| Role | Can do |
|---|---|
| `msme_owner` | Their own dashboard, profile and account. Everyone who registers on the website is this role. |
| `admin` | Everything in the admin portal except admin management and the activity log: review businesses, set verification status, create and manage referral codes. |
| `super_admin` | All of the above, plus create, deactivate and reset admins and read the activity log. |
| `partner` | Belongs to one organisation. Sees only that organisation's opportunities and applicants, and only the details each applicant agreed to share. Created by an admin with a temporary password. |

## Referral codes

Staff and foot soldiers are "agents": each has a code like `NMR-7K3QXM` created by an admin or super admin (no login for agents). A registrant can type the code at registration, or open `/register/?ref=NMR-7K3QXM`. Counts per agent come from the businesses that stored the code. Invalid or deactivated codes are refused with a generic message so codes cannot be guessed by trial; owners never see referral data.

## What it provides

| Method and path | What it does |
|---|---|
| `GET /api/health` | Liveness check |
| `POST /api/auth/register` | Creates the account and the business profile (optional `referralCode`), starts a session |
| `POST /api/auth/login` | Logs in, starts a session |
| `POST /api/auth/logout` | Ends the session |
| `GET /api/auth/me` | The signed-in user |
| `GET /api/dashboard` | User, business, profile progress and recommended next actions |
| `GET`, `PATCH /api/business` | Read and update the business profile |
| `PATCH /api/account` | Update name and phone |
| `POST /api/account/password` | Change password (signs out other devices) |
| `DELETE /api/account/sessions` | Log out of all devices |
| `GET /api/admin/overview` | Admin or super admin: totals, status counts, top referrers, recent registrations |
| `GET /api/admin/businesses`, `GET /api/admin/businesses/:id` | Search, filter and page through businesses; one business with owner and referral |
| `POST /api/admin/businesses/:id/status` | Set verification status with a required note; first Verified issues the NMREP ID |
| `GET`, `POST /api/admin/agents`, `GET`, `PATCH /api/admin/agents/:id` | List and create referral codes; one agent with registrants; edit or deactivate |
| `GET`, `POST /api/admin/admins`, `PATCH /api/admin/admins/:id`, `POST /api/admin/admins/:id/reset-password` | Super admin only: manage admin accounts |
| `GET /api/admin/audit` | Super admin only: activity log |
| `GET /api/opportunities`, `GET /api/opportunities/:id` | Owners: open opportunities with how their business compares (Eligible, Nearly eligible, Not eligible, and "N of M met") |
| `GET /api/applications`, `POST /api/applications`, `GET /api/applications/:id`, `POST /api/applications/:id/withdraw` | Owners: their applications. `POST` saves a draft or submits (`submit: true`), only when every Required requirement is met; a profile snapshot is stored on submit |
| `GET /api/notifications`, `POST /api/notifications/read` | Owners: notifications and marking them read |
| `GET, POST /api/admin/opportunities`, `GET, PATCH /api/admin/opportunities/:id` | Admins: manage opportunities and their requirements. Opening one the first time notifies eligible owners |
| `GET /api/admin/applications`, `GET /api/admin/applications/:id`, `POST /api/admin/applications/:id/status` | Admins: review applications (status with a required note) |
| `GET /api/admin/reports`, `GET /api/admin/export/businesses`, `GET /api/admin/export/applications` | Admins: summary numbers and CSV downloads (recorded in the activity log) |
| `POST /api/auth/forgot-password` | Sends a reset link by email. Always answers the same, whether or not the address is registered |
| `POST /api/auth/reset-password` | Sets a new password from the emailed token. Works once, expires in 1 hour, signs out every session |
| `POST /api/auth/verify-email` | Confirms an email address from the emailed token (valid 48 hours) |
| `POST /api/account/resend-verification` | Sends the confirmation email again (at most one a minute) |
| `GET /api/consents` | Owners: what they agreed to share, with whom, why and when |
| `GET, POST /api/admin/organisations`, `GET, PATCH /api/admin/organisations/:id`, `GET /api/admin/organisation-types` | Admins: partner organisations |
| `POST /api/admin/organisations/:id/users`, `PATCH /api/admin/partner-users/:id`, `POST /api/admin/partner-users/:id/reset-password` | Admins: partner logins (one-time temporary password) |
| `POST /api/admin/opportunities/:id/approve`, `POST /api/admin/opportunities/:id/return` | Admins: approve or send back a partner's opportunity |
| `GET /api/partner/me`, `GET /api/partner/overview` | Partners: who they are, counts for their organisation |
| `GET, POST /api/partner/opportunities`, `GET, PATCH /api/partner/opportunities/:id`, `POST .../submit`, `POST .../close` | Partners: their own opportunities (draft, submit for approval, close) |
| `GET /api/partner/applications`, `GET /api/partner/applications/:id`, `POST /api/partner/applications/:id/status` | Partners: applications to their opportunities, limited to what each applicant agreed to share |
| `GET /api/partner/beneficiaries`, `GET /api/partner/reports` | Partners: approved applicants and their own numbers |

Admin routes refuse owners and anonymous callers, and refuse staff whose temporary password has not been replaced yet (403 `password_change_required`).

## How it is secured

- **Passwords** are hashed with bcrypt (cost 12). Plain passwords are never stored or logged.
- **Sessions** are random 32-byte tokens in an `httpOnly`, `Secure` (in production), `SameSite=Lax` cookie. Only a SHA-256 hash of the token is stored, so a database leak cannot be replayed. Sessions expire after 7 days, are replaced on every login, and are all revoked by "log out of all devices". A password change signs out every other device.
- **CSRF**: state-changing requests must carry an `Origin` header from `CORS_ORIGINS`, in addition to SameSite cookies and strict CORS.
- **Brute force**: per-IP rate limits on login, registration and password change, and an account lock for 15 minutes after 5 failed passwords. A locked account and a wrong password get the identical response, and an unknown email gets the same response too.
- **Input**: every request body is validated with strict schemas. Unknown fields are rejected (so clients cannot set verification status or an NMREP ID), and typed values mean MongoDB operator objects such as `{ "$gt": "" }` fail validation. Mongoose `sanitizeFilter` is on as a second layer.
- **Data minimisation**: NIN, BVN, bank account numbers and documents are not collected or stored.
- **Responses** never include password hashes, stack traces or internal errors. Request logs contain no bodies or cookies.

Known limits: rate-limit counters live in memory (one instance only, reset on restart). Registration tells the visitor when an email is already registered (no email verification yet). There is no email verification or password reset by email yet. A forgotten admin password is reset by a super admin; a forgotten super admin password needs a database change or a new reset script. Verification is a manual admin decision, with no document or Prembly checks yet.

Staff safety: temporary passwords are random, shown once and stored only as a hash; deactivating an admin revokes their sessions; every status change and admin action is written to the activity log (summaries only, never passwords).

## Tests

`npm test` runs the integration tests against a temporary in-memory MongoDB: registration, login, lockout, sessions, origin checks, validation, mass assignment, data isolation between users, password change, rate limiting and index checks, plus (in `test/admin.test.js`) referral codes, role access control, forced password change, business search and filters, verification status and NMREP ID issuing, admin management and the audit log. `test/options-sync.test.js` also checks that the allowed select values here match the web app's registration form.
