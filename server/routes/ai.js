// AI-assisted job/company scoring.
//
//   POST /api/ai/fit-score   body: { company_id, job_id? }  -> { score, reason, cached } | { available: false }
//
// Requires a logged-in session (the fit score is scored against *your*
// profile) but works with the dummy auth already used everywhere else.

const express = require('express');
const { getCompany, getJob } = require('../db');
const { getUserFromRequest } = require('./auth');
const { scoreFit, hasKey: hasAiKey } = require('../services/aiFitService');

const router = express.Router();

router.get('/fit-score/available', (req, res) => {
  res.json({ available: hasAiKey() });
});

router.post('/fit-score', async (req, res) => {
  if (!hasAiKey()) {
    return res.json({ available: false, message: 'ANTHROPIC_API_KEY not configured' });
  }

  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { company_id, job_id } = req.body || {};
  const company = await getCompany(company_id, user.id);
  if (!company) return res.status(404).json({ error: 'company not found' });

  let job = null;
  if (job_id != null) {
    job = await getJob(job_id, user.id);
    if (!job || job.company_id !== company_id) {
      return res.status(400).json({ error: 'job does not belong to this company' });
    }
  }

  const result = await scoreFit(company, job, user.profile || {}, user.id);
  if (!result) return res.status(502).json({ error: 'Could not compute a fit score right now — try again shortly.' });
  res.json({ available: true, ...result });
});

module.exports = router;
