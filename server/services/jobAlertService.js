// Periodic check: find recently-scraped jobs, match them against users who
// scanned that area and have skills that fit, and email a batched digest —
// never one email per job, and never more than one email per user per
// ALERT_MIN_INTERVAL_MS regardless of how many jobs matched in between.

const crypto = require('crypto');
const db = require('../db');
const { companyMatchesProfile } = require('./skillMatchService');
const { sendJobAlertEmail } = require('./systemMailService');

const CHECK_LOOKBACK_MS = 45 * 60 * 1000; // safety overlap over the 30-min check interval
const ALERT_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

async function matchNewJobs() {
  const jobs = await db.getRecentlyFetchedJobsWithCompany(Date.now() - CHECK_LOOKBACK_MS);
  for (const job of jobs) {
    if (job.lat == null || job.lng == null) continue;
    const company = { opportunities: safeJSON(job.opportunities, []) };
    let candidates;
    try {
      candidates = await db.getCandidateUsersForLocation(job.lat, job.lng);
    } catch (err) {
      console.warn('[job-alerts] candidate lookup failed:', err.message);
      continue;
    }
    for (const user of candidates) {
      try {
        const profile = safeJSON(user.profile_json, {});
        if (!companyMatchesProfile(company, profile)) continue;
        await db.recordJobAlertMatch(user.id, job.job_id);
      } catch (err) {
        console.warn('[job-alerts] match/record failed for user', user.id, err.message);
      }
    }
  }
}

async function sendPendingDigests() {
  const base = process.env.PUBLIC_URL || '';
  const users = await db.getUsersWithUnsentAlerts();
  for (const user of users) {
    try {
      if (user.last_alert_sent_at && Date.now() - user.last_alert_sent_at < ALERT_MIN_INTERVAL_MS) continue;

      const pending = await db.getUnsentAlertsForUser(user.id);
      if (!pending.length) continue;

      let token = user.unsubscribe_token;
      if (!token) {
        token = crypto.randomBytes(32).toString('hex');
        await db.setUnsubscribeToken(user.id, token);
      }

      const sent = await sendJobAlertEmail(user.email, {
        jobs: pending,
        unsubscribeUrl: `${base}/api/auth/unsubscribe-alerts?token=${token}`,
      });
      if (sent) await db.markAlertsSent(user.id, pending.map(j => j.job_id));
    } catch (err) {
      console.warn('[job-alerts] digest send failed for user', user.id, err.message);
    }
  }
}

async function runJobAlertsCheck() {
  await matchNewJobs();
  await sendPendingDigests();
}

module.exports = { runJobAlertsCheck };
