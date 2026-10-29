# Deploying the NMREP API to your VPS

A step-by-step guide for putting the backend on `169.58.49.146` using only SSH. The frontend comes later (section 14).

You will end up with this:

```
Visitor's browser or the app
        |  HTTPS (https://api.nmrep.ng)
        v
     nginx  (ports 80 and 443, the only thing open to the internet)
        |  http://127.0.0.1:4000  (this machine only)
        v
 NMREP API  (Node.js, runs as its own user, restarts by itself, starts at boot)
        |  127.0.0.1:27017  (this machine only)
        v
    MongoDB  (password protected, backed up every night)

Emails (password reset, email confirmation, updates)  -->  Resend
```

Set aside about 2 hours the first time. Do the steps in order. Every command is meant to be copied exactly. Lines that start with `#` are comments, not commands.

**Words used here:** *the server* is your VPS. *Your PC* is the Windows computer you work on. A command marked **[PC]** runs in Windows PowerShell on your PC. Everything else runs on the server over SSH.

---

## 0. What you need before you start

| Need | Notes |
|---|---|
| The server's address and root login | `ssh root@169.58.49.146` |
| Control of the DNS records of `nmrep.ng` | Where the domain is managed (often the cPanel "Zone Editor" of your current hosting, or your registrar). You need it for the API address and for Resend. |
| A password manager | You will create about 6 passwords. Never store them in a file on the server or in a chat. |
| A Resend account | Free at resend.com. Used in section 10. |
| An email address you can read | For the HTTPS certificate notices and the test email. |
| The project folder on your PC | `C:\Users\HP\Desktop\MSME` |

**Check these first, on the server** (they decide some choices later):

```bash
cat /etc/os-release | head -3          # this guide is written for Ubuntu 22.04 or 24.04
free -h                                # memory: MongoDB is comfortable with 2 GB or more
df -h /                                # disk space: at least 10 GB free
grep -m1 -o avx /proc/cpuinfo          # MongoDB 5 and newer needs the "avx" CPU feature; this must print "avx"
```

- If the system is not Ubuntu (for example Debian or AlmaLinux), stop and tell me which one. Package names and a few commands differ.
- If `avx` is **not** printed, the newest MongoDB will not start on this server. Tell me, and we will either use MongoDB Atlas (keep the database where it is today) or an older MongoDB.
- If memory is under 2 GB, add a swap file in section 2.6.

---

## 1. Point `api.nmrep.ng` at the server (DNS)

Do this first, because DNS can take a while to spread.

In the DNS settings of `nmrep.ng`, add one record:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| A | `api` | `169.58.49.146` | 300 (5 minutes) or the lowest allowed |

Leave `nmrep.ng` and `www` alone: they stay on your shared hosting.

Check it from your PC **[PC]** (it can take from a few minutes to an hour):

```powershell
nslookup api.nmrep.ng
```

It must answer with `169.58.49.146`. Do not continue to section 8 (HTTPS) until it does.

> **Why a real domain matters:** the website at `nmrep.ng` and the API at `api.nmrep.ng` share the same registrable domain, so the login cookie works in every browser (Safari, Firefox, phones). An address like `https://169.58.49.146` cannot get a normal certificate and would bring back the cookie problems you had with Render.

---

## 2. First login and securing the server

Open a terminal on your PC **[PC]** and connect:

```powershell
ssh root@169.58.49.146
```

Accept the host key question the first time (type `yes`). **Keep this window open until section 2.4 is finished.**

### 2.1 Update everything

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates gnupg ufw fail2ban unattended-upgrades nano git
timedatectl set-timezone Africa/Lagos      # only changes how times are shown in logs
```

If it says a reboot is needed, run `reboot`, wait a minute, and log in again.

### 2.2 Create your everyday user and the service user

Never work as root day to day. Create an administrator user called `deploy`:

```bash
adduser deploy                 # choose a strong password and store it in your password manager; press Enter for the other questions
usermod -aG sudo deploy
```

Create a separate user that only runs the API. It cannot log in:

```bash
adduser --system --group --home /opt/nmrep --shell /usr/sbin/nologin nmrep
mkdir -p /opt/nmrep/releases /opt/nmrep/shared
chown -R nmrep:nmrep /opt/nmrep
chmod 750 /opt/nmrep
```

### 2.3 Log in with a key instead of a password

On your PC **[PC]**, create a key (press Enter for the default location; choose a passphrase and store it in your password manager):

```powershell
ssh-keygen -t ed25519 -C "nmrep-vps"
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

The second command prints one line starting with `ssh-ed25519`. Copy that whole line. **Never copy the file without `.pub`: that is your private key.**

Back in the server window, install the key for `deploy`:

```bash
mkdir -p /home/deploy/.ssh
nano /home/deploy/.ssh/authorized_keys      # paste the line, then Ctrl+O, Enter, Ctrl+X
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 2.4 Test the new login before closing anything

Open a **second** PowerShell window on your PC **[PC]**:

```powershell
ssh deploy@169.58.49.146
sudo whoami          # type deploy's password; it must print: root
```

If that works, you can continue. If it does not, fix it first. The root window is still open, so you cannot lock yourself out yet.

### 2.5 Turn off root and password logins

In the **root** window:

```bash
nano /etc/ssh/sshd_config.d/99-nmrep.conf
```

Paste this, save (Ctrl+O, Enter, Ctrl+X):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
```

Check it and apply it:

```bash
sshd -t && systemctl reload ssh      # on some systems the service is called sshd: systemctl reload sshd
```

Now open a **new** PowerShell window on your PC and try `ssh deploy@169.58.49.146` again. It must still work, and `ssh root@169.58.49.146` must now be refused. Only then close the root window. From now on you use `deploy` and `sudo`.

### 2.6 Firewall, brute-force protection, automatic security updates

As `deploy`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable                    # answer y
sudo ufw status verbose
```

Only SSH, HTTP and HTTPS are open. **MongoDB's port is not, and must never be.** If your hosting company also has a firewall in its control panel, allow only 22, 80 and 443 there too.

```bash
sudo dpkg-reconfigure -plow unattended-upgrades     # choose Yes
```

fail2ban (bans addresses that keep guessing SSH passwords). The settings file is in the project at `backend/deploy/fail2ban-jail.local`; you will copy it in section 5.4. For now:

```bash
sudo systemctl enable --now fail2ban
```

If the server has **less than 2 GB of memory**, add swap so MongoDB is not killed:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 3. Install Node.js, nginx and certbot

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx
node --version        # v22.x
nginx -v
```

Hide the nginx version number from visitors:

```bash
sudo nano /etc/nginx/nginx.conf       # inside the http { ... } block add:   server_tokens off;
```

---

## 4. Install and secure MongoDB

### 4.1 Install

This uses MongoDB 8.0 from MongoDB's own repository:

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager      # "active (running)"
```

### 4.2 Create the database users (with the password check turned off for a moment)

You will create three users. Make three different strong passwords first. A simple way that avoids special characters (so they are safe inside a connection address):

```bash
openssl rand -hex 24        # run it three times; store each result in your password manager with the user name
```

Open the MongoDB shell and run the commands below. `passwordPrompt()` asks you for the password without showing it and without saving it in history. Paste one password at each prompt:

```bash
mongosh
```

```javascript
use admin
db.createUser({ user: "nmrep_admin", pwd: passwordPrompt(), roles: [ { role: "root", db: "admin" } ] })

use nmrep
db.createUser({ user: "nmrep_app", pwd: passwordPrompt(), roles: [ { role: "readWrite", db: "nmrep" } ] })
db.createUser({ user: "nmrep_backup", pwd: passwordPrompt(), roles: [ { role: "read", db: "nmrep" } ] })
exit
```

- `nmrep_admin` is for you, for maintenance only. The API never uses it.
- `nmrep_app` is what the API uses. It can only read and write the `nmrep` database.
- `nmrep_backup` can only read, for the nightly backup.

### 4.3 Lock it down

```bash
sudo nano /etc/mongod.conf
```

Make sure these two parts look like this (change them if they differ; keep the rest as it is):

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1

security:
  authorization: enabled
```

`bindIp: 127.0.0.1` means MongoDB answers only to programs on this same server. `authorization: enabled` means a password is required.

```bash
sudo systemctl restart mongod
```

### 4.4 Check it

```bash
# This must FAIL with "requires authentication" (proves the lock is on):
mongosh --quiet --eval 'db.getSiblingDB("nmrep").getCollectionNames()'

# This must work (type the nmrep_app password when asked):
mongosh --quiet -u nmrep_app -p --authenticationDatabase nmrep nmrep --eval 'db.runCommand({ ping: 1 })'

# Nothing may be listening on the internet side. This must show 127.0.0.1:27017 only:
sudo ss -tlnp | grep 27017
```

### 4.5 The API's database address

You will paste this in section 6, with the real `nmrep_app` password in place of `PASSWORD`:

```
mongodb://nmrep_app:PASSWORD@127.0.0.1:27017/nmrep?authSource=nmrep
```

### 4.6 Do you want your Atlas test data?

Probably not: it is test data, and starting clean is simpler and safer. Skip this unless you really need it. If you do, tell me and I will add a migration section.

---

## 5. Upload the backend

### 5.1 Make the upload file **[PC]**

In PowerShell, in the project folder. This leaves out `node_modules` (they are installed on the server) and, importantly, **your local `.env` with its secrets**:

```powershell
cd C:\Users\HP\Desktop\MSME
tar -czf nmrep-backend.tar.gz --exclude=backend/node_modules --exclude=backend/.env --exclude=backend/test --exclude=backend/.git backend
```

Check that no secret file is inside. This must print nothing (the file `backend/.env.example` is allowed and does not match, because it contains only placeholders):

```powershell
tar -tzf nmrep-backend.tar.gz | Select-String -Pattern "\.env$"
```

> If it prints anything, stop and tell me before sending the file.

### 5.2 Send it **[PC]**

```powershell
scp nmrep-backend.tar.gz deploy@169.58.49.146:/tmp/
```

### 5.3 Unpack the helper files on the server

```bash
mkdir -p /tmp/nmrep-unpack && tar -xzf /tmp/nmrep-backend.tar.gz -C /tmp/nmrep-unpack
cd /tmp/nmrep-unpack/backend/deploy
# Remove any Windows line endings, which would break the scripts:
sed -i 's/\r$//' deploy.sh backup-mongo.sh nmrep-api.service nginx-api.nmrep.ng.conf fail2ban-jail.local
```

### 5.4 Install them

```bash
sudo install -m 755 deploy.sh        /usr/local/bin/nmrep-deploy
sudo install -m 755 backup-mongo.sh  /usr/local/bin/nmrep-backup
sudo install -m 644 nmrep-api.service /etc/systemd/system/nmrep-api.service
sudo install -m 644 nginx-api.nmrep.ng.conf /etc/nginx/sites-available/api.nmrep.ng
sudo install -m 644 fail2ban-jail.local /etc/fail2ban/jail.local
sudo systemctl daemon-reload
sudo systemctl enable nmrep-api
sudo systemctl restart fail2ban
```

---

## 6. Create the settings file (`.env`)

All settings live in one file outside the code, so a new release never overwrites them. Only the `nmrep` user can read it.

```bash
sudo -u nmrep nano /opt/nmrep/shared/.env
```

Paste the block below, **replace every `CHANGE_ME` and placeholder**, save (Ctrl+O, Enter, Ctrl+X). The values for Resend come in section 10: leave them as they are for now.

```
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
TRUST_PROXY=1

MONGODB_URI=mongodb://nmrep_app:CHANGE_ME_NMREP_APP_PASSWORD@127.0.0.1:27017/nmrep?authSource=nmrep

CORS_ORIGINS=https://nmrep.ng

APP_URL=https://nmrep.ng
EMAIL_FROM=NMREP <no-reply@nmrep.ng>
RESEND_API_KEY=
```

Notes:

- `CORS_ORIGINS` must be exactly the address of your website, with no slash at the end. If you also want to test from `https://www.nmrep.ng`, add it after a comma.
- Leave `RESEND_API_KEY=` empty until section 10. The API still starts; emails are just not sent.
- Do **not** set `ALLOW_TOKEN_AUTH`. It is a legacy testing switch. The mobile app does not need it: it sends `X-Client: app` and gets a Bearer token automatically.
- The full list of settings with explanations is in `backend/.env.example`.

Make sure no one else can read it:

```bash
sudo chown nmrep:nmrep /opt/nmrep/shared/.env
sudo chmod 600 /opt/nmrep/shared/.env
sudo ls -l /opt/nmrep/shared/.env        # -rw------- nmrep nmrep
```

---

## 7. Deploy and start the API

```bash
sudo nmrep-deploy /tmp/nmrep-backend.tar.gz
```

It unpacks a new release, installs dependencies, starts the service, checks `/api/health`, and rolls back by itself if the API does not start. It ends with `Deployed ...`.

Check:

```bash
curl -s http://127.0.0.1:4000/api/health          # {"status":"ok","database":true}
sudo systemctl status nmrep-api --no-pager
sudo journalctl -u nmrep-api -n 30 --no-pager
```

If `database` is `false` or the service keeps restarting, see the troubleshooting table (section 13).

### 7.1 Create the first super admin

The super admin you created earlier exists only in the old database. Create one on this server. Use a long, unique password (not `Test123@@`):

```bash
sudo -u nmrep bash -c 'cd /opt/nmrep/current/backend && npm run create-super-admin'
```

---

## 8. nginx and HTTPS

Only continue when `nslookup api.nmrep.ng` shows `169.58.49.146` (section 1).

```bash
sudo ln -s /etc/nginx/sites-available/api.nmrep.ng /etc/nginx/sites-enabled/api.nmrep.ng
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                         # must say "syntax is ok" and "test is successful"
sudo systemctl reload nginx
curl -s http://api.nmrep.ng/api/health        # works over plain HTTP for now
```

Get the free HTTPS certificate. Use an email address you read; it receives expiry warnings:

```bash
sudo certbot --nginx -d api.nmrep.ng --redirect --agree-tos --no-eff-email -m you@example.com
sudo certbot renew --dry-run          # proves automatic renewal works
```

Check from your PC **[PC]**:

```powershell
curl.exe -i https://api.nmrep.ng/api/health
```

You should see `HTTP/1.1 200 OK`, a `Strict-Transport-Security` header and `{"status":"ok","database":true}`. Visiting `http://api.nmrep.ng` must redirect to HTTPS.

Check the login cookie is built correctly (replace the details with the super admin you created):

```powershell
curl.exe -i -X POST https://api.nmrep.ng/api/auth/login -H "Origin: https://nmrep.ng" -H "Content-Type: application/json" -d "{\"email\":\"YOUR_SUPER_ADMIN_EMAIL\",\"password\":\"YOUR_PASSWORD\"}"
```

The `Set-Cookie: nmrep_session=...` line must contain `HttpOnly`, `Secure` and `SameSite=Lax`. If it does, the cookie works for the website on `nmrep.ng`.

---

## 9. Backups

An untested backup is not a backup. This takes 10 minutes and is the most important safety step.

### 9.1 The backup login file (readable by root only)

```bash
sudo mkdir -p /etc/nmrep
sudo nano /etc/nmrep/mongodump.yaml
```

Paste (with the real `nmrep_backup` password), then save:

```yaml
uri: "mongodb://nmrep_backup:CHANGE_ME_NMREP_BACKUP_PASSWORD@127.0.0.1:27017/nmrep?authSource=nmrep"
```

```bash
sudo chmod 600 /etc/nmrep/mongodump.yaml
sudo chown root:root /etc/nmrep/mongodump.yaml
```

### 9.2 Run one by hand

```bash
sudo nmrep-backup
sudo ls -lh /var/backups/nmrep
```

### 9.3 Every night at 02:30

```bash
sudo crontab -e        # choose nano if asked; add this line at the bottom:
```

```
30 2 * * * /usr/local/bin/nmrep-backup >> /var/log/nmrep-backup.log 2>&1
```

Backups older than 14 days are deleted automatically.

### 9.4 Copy them off the server

If this server is lost, backups kept on it are lost too. Edit the end of `/usr/local/bin/nmrep-backup` (the "OFF-SERVER COPY" part) to send each file to another server or a storage bucket. Tell me which you prefer and I will write the exact steps.

### 9.5 Practise restoring (once, before launch)

The goal is to prove a backup file can be turned back into a working database, without touching the real data. You restore into a scratch database called `nmrep_restore_test` and then delete it.

```bash
sudo nano /etc/nmrep/mongorestore.yaml
```

```yaml
uri: "mongodb://nmrep_admin:CHANGE_ME_NMREP_ADMIN_PASSWORD@127.0.0.1:27017/?authSource=admin"
```

```bash
sudo chmod 600 /etc/nmrep/mongorestore.yaml
sudo ls /var/backups/nmrep                                   # pick a file name
sudo mongorestore --config=/etc/nmrep/mongorestore.yaml --gzip --archive=/var/backups/nmrep/NAME_OF_A_BACKUP.archive.gz --nsFrom='nmrep.*' --nsTo='nmrep_restore_test.*'
sudo mongosh --quiet "mongodb://127.0.0.1:27017/?authSource=admin" -u nmrep_admin -p --eval 'db.getSiblingDB("nmrep_restore_test").users.countDocuments()'
```

The last command asks for the `nmrep_admin` password and prints how many users are in the restored copy. When you have seen that, delete the scratch database and the restore file:

```bash
sudo mongosh --quiet "mongodb://127.0.0.1:27017/?authSource=admin" -u nmrep_admin -p --eval 'db.getSiblingDB("nmrep_restore_test").dropDatabase()'
sudo rm /etc/nmrep/mongorestore.yaml
```

To restore for real after a disaster, use the same `mongorestore` command without `--nsFrom` and `--nsTo`, after stopping the API (`sudo systemctl stop nmrep-api`) and starting it again afterwards.

---

## 10. Email with Resend

The API sends email for: password reset links, confirming a new owner's email address, and short updates about verification and application decisions. It never emails passwords, staff notes or business details.

### 10.1 Add and verify your domain in Resend

1. Sign in at resend.com, open **Domains**, click **Add Domain**, enter `nmrep.ng`, choose the region closest to Nigeria that Resend offers.
2. Resend shows a list of DNS records (typically an MX record and TXT records for SPF and DKIM). Add **every one** of them exactly as shown in the DNS settings of `nmrep.ng`, then click **Verify**. It can take from minutes to a few hours.
3. Wait until the domain shows **Verified**. Until then Resend refuses to send from `no-reply@nmrep.ng`.
4. Optional but recommended: add a DMARC record `_dmarc` (TXT) with the value `v=DMARC1; p=none; rua=mailto:you@yourdomain` so receivers trust your mail more.

> If `nmrep.ng` already receives email (for example through your hosting), the records Resend asks for are normally on a sub-domain such as `send.nmrep.ng`, so they do not interfere. If Resend asks you to change an existing MX or SPF record on the main name, stop and ask me.

### 10.2 Create the API key

In Resend open **API Keys**, click **Create API Key**, give it the name `nmrep-vps`, set permission to **Sending access**, and restrict it to the domain `nmrep.ng`. Copy the key (it starts with `re_`). **Resend shows it once.** Store it in your password manager.

### 10.3 Put it in the server's `.env`

```bash
sudo -u nmrep nano /opt/nmrep/shared/.env
```

Set the line (no spaces, no quotes):

```
RESEND_API_KEY=re_your_real_key_here
```

Check that `EMAIL_FROM` uses your verified domain, then restart:

```bash
sudo systemctl restart nmrep-api
sudo journalctl -u nmrep-api -n 10 --no-pager      # there must be NO "email is OFF" warning
```

### 10.4 Send a test email

```bash
sudo -u nmrep bash -c 'cd /opt/nmrep/current/backend && npm run send-test-email -- your-own-address@gmail.com'
```

It prints `Resend accepted the message`. Check your inbox and your spam folder. If it says **refused**:

| Cause | Fix |
|---|---|
| The domain is not verified yet | Finish 10.1 |
| `EMAIL_FROM` uses a different domain from the verified one | Make them match |
| Wrong or restricted key | Create a new key in 10.2 |
| A free account can only send to its own address until a domain is verified | Verify the domain |

### 10.5 What happens in the product

- A new owner gets a "Confirm your email address" email. Until they confirm, their dashboard shows a banner with a "Send the email again" button. Nothing is blocked.
- "Forgot your password?" on the login page sends a one-hour, one-time link. Using it signs the person out everywhere. The page always says "if an account uses this address, we have sent a link", so nobody can use it to find out who is registered.
- To stop the update emails (verification and application decisions) but keep reset and confirmation emails, set `EMAIL_NOTIFICATIONS=false`.
- The links go to `https://nmrep.ng/reset-password/` and `https://nmrep.ng/verify-email/`. **Those pages are part of the frontend**, so they work only after you upload the new website (section 14). Until then, the links in emails lead to a missing page.

### 10.6 Automated verification checks (Prembly), optional

Owners can check their NIN, BVN, CAC number and TIN from **Verification** in their dashboard. This is **off** until you add two settings, and manual review works without it. Every provider call can cost money, so create the Prembly account first, fund the wallet only with what you are happy to spend, and read the limits below.

1. In the Prembly dashboard create an API key for the services NIN, BVN, CAC and TIN. Copy it into your password manager. Prembly has a **test mode** (a switch in its dashboard): the same address and the same paths, with a test key (it starts with `test_`). In test mode every call succeeds with made up data, nothing is billed, and the answer says `"is_sandbox": true`. Use it on your own computer and on a test server. **The production server must use the live key**: if it receives a test mode answer it logs "answered in sandbox mode" and treats the check as unavailable, so made up data is never recorded as a real check. To try the test key, put it in `backend/.env` on your computer and run `npm run prembly-check` (it prints only the shape of each answer, never the key or any values).
2. Create the fingerprint secret on the server (it is not a password you need to remember, but **keep a copy in your password manager and never change it**, or earlier fingerprints stop matching):

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

3. Add both lines to `/opt/nmrep/shared/.env` (no spaces, no quotes), then restart:

   ```
   PREMBLY_API_KEY=your_real_prembly_key
   VERIFICATION_HASH_KEY=the_long_random_value_from_step_2
   ```

   ```bash
   sudo systemctl restart nmrep-api
   sudo journalctl -u nmrep-api -n 10 --no-pager      # there must be NO "Automated verification checks are off" warning
   ```

What the owner and the platform do:

- **NIN and BVN** are typed by the owner, who must tick an agreement. The number is sent once to Prembly and is never stored or logged. NMREP keeps the last four digits, a keyed fingerprint (so the same number on two accounts can be noticed), whether the name and phone matched, and Prembly's reference. The date of birth, address and photo that Prembly returns are thrown away immediately.
- **CAC and TIN** use the numbers already in the business profile.
- A passed check moves an **Unverified** business to **Pending Verification** so it appears in the admin review queue. **Only an administrator can set Verified.**
- Each business can run a type of check **3 times** and all checks **8 times** per rolling 24 hours (`VERIFICATION_MAX_PER_TYPE_PER_DAY`, `VERIFICATION_MAX_PER_DAY`). A number that already passed is answered from the saved result without calling Prembly again.
- If Prembly refuses the key or the wallet is empty, owners see "Verification is not available right now" and the server log says `Verification provider refused the request: HTTP 402` (or 401, 403). Top up the wallet or replace the key. Log lines never contain numbers or keys.
- Deleting an account deletes its check results.

### 10.7 The document wallet, optional

Owners can keep documents (CAC certificate, licences, and so on) in **Documents** and attach chosen ones to an application. It is **off** until you set a key. Files never go to a third party: they are encrypted on this server and stored in a private folder.

1. Create the key (it only prints, it writes nothing; **keep a copy in your password manager, separately from the backups**):

   ```bash
   cd /opt/nmrep/current/backend && npm run document-key
   ```

2. Add to `/opt/nmrep/shared/.env` (no spaces, no quotes):

   ```
   DOCUMENT_ENCRYPTION_KEY=the_value_from_step_1
   DOCUMENT_STORAGE_DIR=/var/lib/nmrep/documents
   ```

3. The service file already has `StateDirectory=nmrep`, which makes systemd create `/var/lib/nmrep` for the service user with mode 0700. If you installed the service file before this change, copy the new `deploy/nmrep-api.service` over `/etc/systemd/system/nmrep-api.service`, then:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart nmrep-api
   sudo journalctl -u nmrep-api -n 10 --no-pager      # there must be NO "document wallet is off" warning
   sudo ls -ld /var/lib/nmrep                         # drwx------ nmrep nmrep
   ```

What to know:

- Each file is encrypted with AES-256-GCM before it is written, under a random name, with a fresh random value for every file. A copy of the folder or of a backup cannot be read without the key. **If the key is lost, every stored document is lost. Never change it while documents exist.**
- The type is decided from the first bytes of the file (PDF, JPEG or PNG only), never from its name. Limits: 5 MB per file, 20 files and 40 MB per business (`DOCUMENT_MAX_MB`, `DOCUMENT_MAX_FILES`, `DOCUMENT_MAX_TOTAL_MB`). The files are not scanned for viruses; downloads are always sent as attachments with `nosniff`.
- An organisation sees only the documents an owner attached to an application, only while that sharing is active (withdrawn, replaced and deleted ends it), and **every download by an organisation or by NMREP staff is written to the activity log**.
- The nightly backup script now also saves `/var/lib/nmrep/documents` to `/var/backups/nmrep/nmrep-documents-*.tar.gz`. Copy those off the server like the database backups.
- nginx already allows requests up to 64 KB. **Uploads need more**: set `client_max_body_size 8m;` in the `location /api/documents` block (the site file in `deploy/nginx-api.nmrep.ng.conf` has it), then `sudo nginx -t && sudo systemctl reload nginx`.
- Deleting an account deletes its files from the disk.

### 10.8 The registration fee (Paystack), optional

Every business owner pays ₦1,000 a year through Paystack. It is **off** until you set a Paystack secret key.

1. In the Paystack dashboard, copy the **secret key** (Settings, API Keys & Webhooks). Start with the **test** key (`sk_test_...`): it takes Paystack's test cards and moves no money. Use the live key (`sk_live_...`) only at launch.
2. In the same page set the **webhook URL** to `https://api.nmrep.ng/api/webhooks/paystack`. Paystack tells the server about every payment there, so a payment is recorded even if the payer closes the page. The server checks the signature and asks Paystack to confirm each payment, so nobody can fake one.
3. Add to `/opt/nmrep/shared/.env` (no spaces, no quotes), then restart:

   ```
   PAYSTACK_SECRET_KEY=sk_test_the_value_from_paystack
   REGISTRATION_FEE_NAIRA=1000
   REGISTRATION_PERIOD_DAYS=365
   ```

   ```bash
   sudo systemctl restart nmrep-api
   sudo journalctl -u nmrep-api -n 10 --no-pager      # "Registration fee is ON: N1000 a year through Paystack. (test key)"
   ```

What to know:

- **Existing accounts will be asked to pay at their next sign-in** once the key is set, because they have not paid yet. If you want existing owners to have a free first year, tell the developer before switching it on.
- With a **test** key the server prints a warning on start: real payments do not work until the live key is set. Use only Paystack's test cards.
- Nothing about cards ever reaches the NMREP server or the website: the payer pays on Paystack's own page.
- Remove the key (or leave it unset) to switch the fee off again; nobody is blocked then.

### 10.9 Push notifications, "Stop these emails" links and reminders

- **Push** goes through Expo and needs nothing from you: it is on by default and sends nothing until the phone app registers phones. `PUSH_ENABLED=false` switches it off. `EXPO_ACCESS_TOKEN` is only needed if you turn on "enhanced push security" in your Expo account.
- **UNSUBSCRIBE_SECRET** signs the "Stop these emails" link in notification emails. Set it once to a long random value and never change it, otherwise old links in sent emails stop working. Create one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` and add it to `/opt/nmrep/shared/.env`. The server warns on start while it is missing.
- **Reminders** (a programme closing in 3 days and 1 day, a training session tomorrow) run inside the API every hour and never send the same reminder twice. `REMINDERS_ENABLED=false` switches them off.
- Large messages (for example a message to every owner) are emailed in batches of 100 with a short pause, so Resend's rate limit is not hit. A big message can take a few minutes to finish.

### 10.10 The /docs password (on the PC that builds the website)

The `/docs` page of the website is protected by a password that is set **when the website is built**, not on the server. On the PC, put `DOCS_PASSWORD=your-long-password` in the website folder's `.env` file (never commit it), then run `npm run build`. The documentation is encrypted with that password inside the built files. Without the variable, the page is not published. To change the password, change the value and build and upload again. Share the password only with the app developer.

---

## 11. Check everything, then reboot once

```bash
sudo systemctl is-active nmrep-api mongod nginx fail2ban          # four lines: active
sudo ufw status                                                    # only 22, 80, 443
sudo ss -tlnp | grep -E ':(27017|4000)'                            # both on 127.0.0.1 only
```

Reboot to prove everything starts by itself:

```bash
sudo reboot
```

Wait a minute, log in again, and run `curl -s https://api.nmrep.ng/api/health` from your PC. It must still answer.

Optional but wise: add a free uptime monitor (for example UptimeRobot) that requests `https://api.nmrep.ng/api/health` every 5 minutes and emails you when it fails.

---

## 12. Everyday operations

| Task | Command |
|---|---|
| See if the API is running | `sudo systemctl status nmrep-api --no-pager` |
| Follow the live log | `sudo journalctl -u nmrep-api -f` (stop with Ctrl+C) |
| Last errors | `sudo journalctl -u nmrep-api -p err -n 50 --no-pager` |
| Restart the API | `sudo systemctl restart nmrep-api` |
| Disk space | `df -h /` and `du -sh /var/backups/nmrep` |
| Change a setting | `sudo -u nmrep nano /opt/nmrep/shared/.env` then `sudo systemctl restart nmrep-api` |
| Create another super admin | the command in 7.1 |

### Deploying a new version

1. **[PC]** make the tarball and send it (5.1 and 5.2).
2. On the server: `sudo nmrep-deploy /tmp/nmrep-backend.tar.gz`.

If the new release does not become healthy, the script goes back to the previous one by itself. To go back by hand to an older release:

```bash
ls -1t /opt/nmrep/releases                                  # newest first
sudo ln -sfn /opt/nmrep/releases/OLDER_FOLDER_NAME /opt/nmrep/current
sudo systemctl restart nmrep-api
```

Limit how large the system log can grow (once):

```bash
sudo nano /etc/systemd/journald.conf        # set:  SystemMaxUse=500M
sudo systemctl restart systemd-journald
```

---

## 13. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `ssh: Permission denied (publickey)` | The key was not installed for `deploy`, or the file permissions are wrong (2.3). Do not close an existing working session while fixing it. |
| `curl: (7) Failed to connect` to port 4000 | The API is not running: `sudo journalctl -u nmrep-api -n 50 --no-pager`. |
| `{"status":"ok","database":false}` | MongoDB is down or the password in `MONGODB_URI` is wrong or has special characters that need URL-encoding. Test with the `mongosh -u nmrep_app` command in 4.4. |
| Service restarts every few seconds | Read the log. Usually a wrong `MONGODB_URI`, or MongoDB not started: `sudo systemctl status mongod`. |
| `mongod` will not start | Missing CPU `avx` (section 0), too little memory (add swap), or a typo in `/etc/mongod.conf` (spaces matter in YAML). `sudo journalctl -u mongod -n 40 --no-pager`. |
| certbot says "Could not connect" or "NXDOMAIN" | The DNS record from section 1 is not live yet, or port 80 is blocked by a firewall (also check the hosting company's panel). |
| `502 Bad Gateway` from nginx | The API is not running or not on port 4000. Check `curl http://127.0.0.1:4000/api/health`. |
| `403 forbidden_origin` in the browser or app | The `Origin` is not in `CORS_ORIGINS`. Fix the value (exact address, no slash), restart. |
| Login works but the user is logged out on the next page | The API is on a different site than the website, the cookie is not `Secure`, or `NODE_ENV` is not `production`. Check section 8's cookie test. |
| Test email "refused" | See the table in 10.4. |
| `429 rate_limited` for real users | Many people behind one IP address. Tell me and we adjust the limits. |
| Locked yourself out of SSH | Use the web console in your hosting company's panel to log in and fix `/etc/ssh/sshd_config.d/99-nmrep.conf`. |

---

## 14. When you are ready to upload the frontend

1. In the project's root `.env` on your PC, set `NEXT_PUBLIC_API_URL=https://api.nmrep.ng` (or delete the line: that is the production default).
2. Rebuild the site with `npm run build` and re-create `nmrep-site.zip` (the usual steps in `DEPLOY.md`).
3. `public/.htaccess` already allows `https://api.nmrep.ng` in its security rules. You can remove the old Render address from the `connect-src` line.
4. Upload as usual, then test on a phone with mobile data: register, log in, go to the dashboard, log out. Also test **Forgot your password** end to end, and confirm the email arrives and the link opens `https://nmrep.ng/reset-password/`.
5. Make sure the server's `.env` has `CORS_ORIGINS=https://nmrep.ng` and no `ALLOW_TOKEN_AUTH` line.

---

## 15. Security summary

What this setup gives you:

- Only SSH, HTTP and HTTPS are reachable. MongoDB and the API are reachable only from the server itself.
- No root login and no password login over SSH. Repeated failed logins are banned. Security updates install automatically.
- The API runs as a user with no login, with most of the system hidden from it. It restarts if it crashes and starts at boot.
- HTTPS everywhere, renewed automatically. Cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.
- The database has its own passwords and a separate read-only user for backups.
- Secrets live in two root-only or service-only files (`/opt/nmrep/shared/.env`, `/etc/nmrep/*.yaml`), never in the code, the upload or this document.
- Nightly backups, kept 14 days, with a deploy script that rolls back by itself.

What it does **not** give you, so you can decide later:

- Backups kept on another server (section 9.4 is still to do).
- Encryption of the disk at rest (ask the hosting company whether the server's disk is encrypted, or ask me about adding it).
- Alerts when something breaks (the uptime monitor in section 11 is the minimum).
- A second server. If this one fails, the site is down until it is restored from a backup.

**Never:** open port 27017, use the `nmrep_admin` login in the app, put the `.env` file or any key in a chat or a zip, or run the API as root.
