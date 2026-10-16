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

/** What a mail needs: { to, subject, text, html }. `to` is one address. */
export function createMailer(email, { fetchImpl = fetch, isProd = false, log = console } = {}) {
  const enabled = Boolean(email?.apiKey && email?.from);

  return {
    enabled,
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

export const mailer = {
  get enabled() {
    return current.enabled;
  },
  send: (message) => current.send(message),
};

export const emailSettings = () => settings;
