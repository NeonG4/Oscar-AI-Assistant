/**
 * lib/mailer.js
 * ----------------------------------------------------------------------------
 * Sends the 2FA code. No npm dependency — every provider here is a single
 * HTTPS POST.
 *
 * The provider is auto-detected from whichever API key you set, so you can
 * sign up for any of them without touching this file:
 *
 *   RESEND_API_KEY      → Resend      (easiest; works from onboarding@resend.dev
 *                                      to your own account email with no domain)
 *   POSTMARK_TOKEN      → Postmark    (needs a verified sender signature)
 *   SENDGRID_API_KEY    → SendGrid    (needs a verified single sender)
 *
 * With none of them set, the code is written to the server log instead. That is
 * a real fallback, not a stub: `vercel logs --follow` (or the Runtime Logs tab)
 * shows it, so you can test the whole login flow before signing up anywhere.
 */

export class MailError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'MailError';
    this.detail = detail;
  }
}

export function detectProvider(env = process.env) {
  if (env.RESEND_API_KEY) return 'resend';
  if (env.POSTMARK_TOKEN) return 'postmark';
  if (env.SENDGRID_API_KEY) return 'sendgrid';
  return 'log';
}

export function defaultFrom(env = process.env) {
  if (env.OSCAR_MAIL_FROM) return env.OSCAR_MAIL_FROM;
  // Resend lets you send from this address to your own account email with no
  // domain setup, which makes first-run work with a single env var.
  if (env.RESEND_API_KEY) return 'Oscar <onboarding@resend.dev>';
  return 'Oscar <oscar@localhost>';
}

/* ---------------------------------------------------------------- templates */

export function codeEmail(code, minutes) {
  const subject = `${code} is your Oscar sign-in code`;

  const text = [
    `Your Oscar sign-in code is: ${code}`,
    '',
    `It expires in ${minutes} minutes.`,
    '',
    "If you didn't just try to sign in, someone has your password — change",
    'OSCAR_PASSKEY in your Vercel project settings.',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="max-width:420px;background:#fff;border:1px solid #e2e5ea;border-radius:14px;padding:28px;">
          <tr><td style="font-size:13px;letter-spacing:.08em;color:#626a76;text-transform:uppercase;">Oscar</td></tr>
          <tr><td style="padding-top:8px;font-size:17px;color:#14171c;">Your sign-in code</td></tr>
          <tr><td style="padding:20px 0;">
            <div style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:34px;
                        letter-spacing:.22em;font-weight:600;color:#14171c;background:#f6f7f9;
                        border:1px solid #e2e5ea;border-radius:10px;padding:16px;text-align:center;">${code}</div>
          </td></tr>
          <tr><td style="font-size:14px;color:#626a76;line-height:1.5;">
            Expires in ${minutes} minutes.<br /><br />
            If you didn't just try to sign in, someone has your password &mdash;
            change <code style="font-size:13px;">OSCAR_PASSKEY</code> in your Vercel project settings.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

/* ---------------------------------------------------------------- providers */

async function post(url, headers, body, doFetch) {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MailError('The email provider rejected the message.', detail.slice(0, 300));
  }
  return true;
}

const SENDERS = {
  resend: (msg, env, doFetch) =>
    post(
      'https://api.resend.com/emails',
      { authorization: `Bearer ${env.RESEND_API_KEY}` },
      { from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html },
      doFetch
    ),

  postmark: (msg, env, doFetch) =>
    post(
      'https://api.postmarkapp.com/email',
      { 'x-postmark-server-token': env.POSTMARK_TOKEN, accept: 'application/json' },
      {
        From: msg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        HtmlBody: msg.html,
        MessageStream: 'outbound',
      },
      doFetch
    ),

  sendgrid: (msg, env, doFetch) =>
    post(
      'https://api.sendgrid.com/v3/mail/send',
      { authorization: `Bearer ${env.SENDGRID_API_KEY}` },
      {
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: parseAddress(msg.from).email, name: parseAddress(msg.from).name },
        subject: msg.subject,
        content: [
          { type: 'text/plain', value: msg.text },
          { type: 'text/html', value: msg.html },
        ],
      },
      doFetch
    ),

  log: (msg) => {
    console.log(
      `\n[oscar] No email provider configured. Sign-in code for ${msg.to}: ${msg.code}\n` +
        `[oscar] Set RESEND_API_KEY (or POSTMARK_TOKEN / SENDGRID_API_KEY) to email it instead.\n`
    );
    return true;
  },
};

/** Splits `Name <a@b.com>` into its parts. */
export function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(value || ''));
  if (match) return { name: match[1] || 'Oscar', email: match[2] };
  return { name: 'Oscar', email: String(value || '').trim() };
}

/* ------------------------------------------------------------------- public */

/**
 * @param {{to: string, code: string, minutes?: number}} input
 * @param {{env?: object, fetchImpl?: Function}} [deps]
 * @returns {Promise<{provider: string, delivered: boolean}>}
 */
export async function sendCode(input, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetchImpl || globalThis.fetch;

  const provider = detectProvider(env);
  const minutes = input.minutes || 10;
  const { subject, text, html } = codeEmail(input.code, minutes);

  const msg = {
    to: input.to,
    from: defaultFrom(env),
    code: input.code,
    subject,
    text,
    html,
  };

  await SENDERS[provider](msg, env, doFetch);

  return { provider, delivered: provider !== 'log' };
}
