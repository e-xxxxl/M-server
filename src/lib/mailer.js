/**
 * Sending email through Resend (https://resend.com), over its plain HTTPS API.
 *
 * - The API key lives only in the server's environment (RESEND_API_KEY). It is sent only to api.resend.com
 *   and never logged, returned or stored.
 * - Sending never throws and never blocks the action that caused it: failures are logged without the message
 *   body (which can contain a one-time link) and the caller carries on.
 * - Without a key, email is switched off. Outside production the message is printed to the server console so
 *   the flow can be tried on a development machine. In production nothing is printed.
 */

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const BATCH_SIZE = 100;
const BATCH_GAP_MS = 700;

/** What a mail needs: { to, subject, text, html }. `to` is one address. */
export function createMailer(email, { fetchImpl = fetch, isProd = false, log = console } = {}) {
  const enabled = Boolean(email?.apiKey && email?.from);

  return {
    enabled,
    /** Sends up to 100 messages in one request to Resend. Returns { ok, sent }. */
    async sendMany(messages) {
      if (!enabled) return { ok: false, skipped: true, sent: 0 };
      try {
        const res = await fetchImpl(RESEND_BATCH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${email.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            messages.map(({ to, subject, text, html }) => ({ from: email.from, to: [to], subject, text, html, ...(email.replyTo ? { reply_to: email.replyTo } : {}) })),
          ),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          const reason = await res.json().then((j) => j?.name ?? j?.message ?? "").catch(() => "");
          log.error(`A batch of emails was not sent: Resend answered ${res.status} ${String(reason).slice(0, 80)}`);
          return { ok: false, status: res.status, sent: 0 };
        }
        return { ok: true, sent: messages.length };
      } catch (err) {
        log.error("A batch of emails was not sent:", err?.name ?? "error");
        return { ok: false, sent: 0 };
      }
    },
    async send({ to, subject, text, html }) {
      if (!enabled) {
        if (!isProd) log.log(`[email not sent, no RESEND_API_KEY] to ${to}: ${subject}\n${text}`);
        return { ok: false, skipped: true };
      }
      try {
        const res = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${email.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: email.from,
            to: [to],
            subject,
            text,
            html,
            ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          // Resend explains problems in a small JSON body (for example an unverified domain). Log the reason only.
          const reason = await res.json().then((j) => j?.name ?? j?.message ?? "").catch(() => "");
          log.error(`Email to a user was not sent: Resend answered ${res.status} ${String(reason).slice(0, 80)}`);
          return { ok: false, status: res.status };
        }
        const data = await res.json().catch(() => ({}));
        return { ok: true, id: data?.id ?? null };
      } catch (err) {
        log.error("Email to a user was not sent:", err?.name ?? "error");
        return { ok: false };
      }
    },
  };
}

// One mailer for the whole process, set up once at start. Until then (and in tests) email is off.
let current = createMailer(null, { isProd: true });
let settings = { notifications: false, appUrl: "http://localhost:3000" };

/** Called once by the server and the scripts. */
export function configureMailer(config, options = {}) {
  current = createMailer(config.email, { isProd: config.isProd, ...options });
  settings = { notifications: Boolean(config.email.notifications), appUrl: config.email.appUrl };
  return current;
}

/** Tests put a fake mailer here to see what would have been sent. */
export function setMailer(mailer, nextSettings = {}) {
  current = mailer;
  settings = { ...settings, ...nextSettings };
}

// Messages for many people (a broadcast, a reminder to every eligible owner) go through a queue that sends them in
// batches of 100 with a short pause, so Resend's rate limit is never hit. Messages that must arrive at once (a
// password reset link) use send() directly.
let queued = [];
let timer = null;
let running = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function drain() {
  running = running.then(async () => {
    while (queued.length > 0) {
      const batch = queued.splice(0, BATCH_SIZE);
      try {
        if (current.sendMany) await current.sendMany(batch);
        else for (const m of batch) await current.send(m);
      } catch {
        /* a failed batch is logged by the sender and must never stop the next one */
      }
      if (queued.length > 0) await sleep(BATCH_GAP_MS);
    }
  });
  return running;
}

export const mailer = {
  get enabled() {
    return current.enabled;
  },
  send: (message) => current.send(message),
  /** Adds a message to the batch queue. Returns at once. */
  queue(message) {
    if (!current.enabled) return;
    queued.push(message);
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, 400);
      timer.unref?.();
    }
  },
  /** Sends everything queued now and waits for it. Used by tests and at shutdown. */
  async flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await drain();
  },
};

export const emailSettings = () => settings;
