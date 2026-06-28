// Send outreach email via SMTP (configured in .env).

const nodemailer = require('nodemailer');

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!smtpConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendOutreachEmail({ to, subject, body, fromName, fromEmail, replyTo }) {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS to .env');
  }

  const from = process.env.SMTP_FROM || fromEmail || process.env.SMTP_USER;
  const name = fromName || 'AreaHunt';
  const info = await transport.sendMail({
    from: `"${name.replace(/"/g, '')}" <${from}>`,
    to,
    replyTo: replyTo || fromEmail || from,
    subject: String(subject || '').slice(0, 200),
    text: String(body || ''),
  });

  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { sendOutreachEmail, smtpConfigured };
