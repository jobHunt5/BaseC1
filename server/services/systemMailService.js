// Transactional system email (account verification) — distinct from
// mailService.js, which sends outreach through each USER's own SMTP
// account. This sends as the app itself, using the same SMTP_HOST/PORT/
// USER/PASS/FROM env vars mailService.js already treats as "the app's own
// identity" for its admin-testing fallback path, so no new env vars needed.

const nodemailer = require('nodemailer');

function systemMailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!systemMailConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Never throws — a delivery failure shouldn't block signup or leave a user
// stuck. Callers should treat the return value as best-effort only.
async function sendVerificationEmail(toEmail, verifyUrl) {
  const transport = getTransport();
  if (!transport) {
    console.warn('[system-mail] SMTP not configured — skipping verification email to', toEmail);
    return false;
  }
  try {
    await transport.sendMail({
      from: `"AreaHunt" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: toEmail,
      subject: 'Verify your AreaHunt account',
      text: `Welcome to AreaHunt!\n\nVerify your email address:\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create this account, you can ignore this email.`,
      html: `<p>Welcome to AreaHunt!</p><p><a href="${verifyUrl}">Verify your email address</a></p><p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>`,
    });
    return true;
  } catch (err) {
    console.warn('[system-mail] failed to send verification email:', err.message);
    return false;
  }
}

module.exports = { systemMailConfigured, sendVerificationEmail };
