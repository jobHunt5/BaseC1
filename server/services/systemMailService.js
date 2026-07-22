// Transactional system email (account verification) — distinct from
// mailService.js, which sends outreach through each USER's own SMTP
// account. This sends as the app itself, using the same SMTP_HOST/PORT/
// USER/PASS/FROM env vars mailService.js already treats as "the app's own
// identity" for its admin-testing fallback path, so no new env vars needed.

const nodemailer = require('nodemailer');
const { escapeHtml } = require('./documentBrand');

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

// Job title/company/location/url all originate from scraped third-party
// pages and ATS APIs — never trusted, must be escaped before landing in an
// email sent under the app's own identity (same as escapeHtml is already
// used for this exact class of data in resumeService.js and the frontend's
// rendering of scraped company/job fields). Split out as a pure function so
// the escaping can be unit-tested without a real SMTP transport.
function buildJobAlertEmailContent(jobs, unsubscribeUrl) {
  const count = jobs.length;
  const subject = `${count} new role${count === 1 ? '' : 's'} matching your skills`;
  const safeUrl = (u) => /^https?:\/\//i.test(u || '') ? escapeHtml(u) : null;
  const lines = jobs.map(j => `${j.title} at ${j.company_name}${j.location ? ` (${j.location})` : ''}${j.url ? `\n${j.url}` : ''}`);
  const listHtml = jobs.map(j => {
    const url = safeUrl(j.url);
    return `<li><strong>${escapeHtml(j.title)}</strong> at ${escapeHtml(j.company_name)}${j.location ? ` (${escapeHtml(j.location)})` : ''}${url ? ` — <a href="${url}">View</a>` : ''}</li>`;
  }).join('');
  return {
    subject,
    text: `New roles matching your skills:\n\n${lines.join('\n\n')}\n\n---\nTurn off job alerts: ${unsubscribeUrl}`,
    html: `<p>New roles matching your skills:</p><ul>${listHtml}</ul><p style="color:#888;font-size:12px"><a href="${unsubscribeUrl}">Turn off job alerts</a></p>`,
  };
}

// Best-effort, same as sendVerificationEmail — a delivery failure shouldn't
// crash the periodic alert-check job, just skip that user's digest.
async function sendJobAlertEmail(toEmail, { jobs, unsubscribeUrl }) {
  const transport = getTransport();
  if (!transport) {
    console.warn('[system-mail] SMTP not configured — skipping job alert email to', toEmail);
    return false;
  }
  const { subject, text, html } = buildJobAlertEmailContent(jobs, unsubscribeUrl);
  try {
    await transport.sendMail({
      from: `"AreaHunt" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.warn('[system-mail] failed to send job alert email:', err.message);
    return false;
  }
}

module.exports = { systemMailConfigured, sendVerificationEmail, sendJobAlertEmail, buildJobAlertEmailContent };
