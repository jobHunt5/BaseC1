// Sends outreach email via SMTP. Each signed-in user sends through their
// OWN email account (credentials they add in Profile, decrypted per
// request by the caller and passed in as `account`) — not a single shared
// .env identity impersonating whoever's "From" address happens to be set.
// A shared account authenticating as itself while claiming to be a
// different per-user From address is exactly what SPF/DKIM checks (and
// spam filters) treat as spoofing, which undermines the whole point of
// "trustworthy" outreach. process.env.SMTP_* remains as a last-resort
// fallback only for the admin's own testing, never silently substituted
// in for a real user's identity.

const nodemailer = require('nodemailer');

function accountConfigured(account) {
  return !!(account && account.host && account.user && account.pass);
}

function envConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function smtpConfigured(account) {
  return accountConfigured(account) || envConfigured();
}

function getTransport(account) {
  if (accountConfigured(account)) {
    const port = parseInt(account.port || 587, 10);
    return nodemailer.createTransport({
      host: account.host,
      port,
      secure: port === 465,
      auth: { user: account.user, pass: account.pass },
    });
  }
  if (envConfigured()) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return null;
}

async function sendOutreachEmail({ to, subject, body, fromName, fromEmail, replyTo, account, attachments }) {
  const transport = getTransport(account);
  if (!transport) {
    throw new Error('No sending email account configured — add one in Profile → Email account (for sending)');
  }

  // When sending through the user's own account, the From address MUST be
  // that account's real address (anything else gets rejected or flagged by
  // the provider) — the env fallback path still honours SMTP_FROM/fromEmail
  // for admin testing.
  const from = accountConfigured(account) ? account.user : (process.env.SMTP_FROM || fromEmail || process.env.SMTP_USER);
  const name = fromName || 'AreaHunt';
  const info = await transport.sendMail({
    from: `"${name.replace(/"/g, '')}" <${from}>`,
    to,
    replyTo: replyTo || fromEmail || from,
    subject: String(subject || '').slice(0, 200),
    text: String(body || ''),
    attachments: attachments || [],
  });

  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { sendOutreachEmail, smtpConfigured };
