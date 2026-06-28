// Read & update endpoints for companies + jobs.
//
//   GET    /api/companies                    -> all known companies
//   GET    /api/companies/in-bounds?bbox=... -> companies inside bbox (no rescan)
//   GET    /api/companies/:id                -> single company + jobs
//   PATCH  /api/companies/:id                -> { status?, notes?, user_rating? }
//   POST   /api/companies/:id/refresh-jobs   -> re-pull jobs for this company
//
//   PATCH  /api/jobs/:id                     -> { applied: true|false }

const express = require('express');

const {
  listAllCompanies, listCompaniesInBounds, listCompaniesByPipeline, getCompany,
  setCompanyStatus, setCompanyNotes, setCompanyUserRating, setCompanyEmail,
  listJobsForCompany, upsertJob, setJobApplied, getJob,
  upsertCompany, updateEnrichment, getTeam, updateTeam,
  syncJobsForCompany,
} = require('../db');
const { findJobsForCompany } = require('../services/jobsService');
const { enrichCompany } = require('../services/enrichService');
const { verifyCompanyEmail } = require('../services/emailVerifyService');
const { sendOutreachEmail, smtpConfigured } = require('../services/mailService');
const { generateAiVariants } = require('../services/outreachAiService');
const { classify, inferOpportunities } = require('../services/classifyService');
const {
  resolveTeamLinkedIn,
  discoverCompanyPeople,
  mergeTeamMembers,
  sanitizeTeam,
} = require('../services/linkedinService');

const router = express.Router();

router.get('/companies', (req, res) => {
  const list = listAllCompanies().map(c => ({ ...c, jobs: listJobsForCompany(c.id) }));
  res.json({ count: list.length, companies: list });
});

router.get('/companies/in-bounds', (req, res) => {
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
    return res.status(400).json({ error: 'bbox=south,west,north,east required' });
  }
  const [south, west, north, east] = bbox;
  const list = listCompaniesInBounds({ south, west, north, east })
    .map(c => ({ ...c, jobs: listJobsForCompany(c.id) }));
  res.json({ count: list.length, companies: list });
});

router.get('/companies/pipeline', (req, res) => {
  const kind = String(req.query.kind || 'interested');
  if (!['interested', 'applied'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be interested or applied' });
  }
  const list = listCompaniesByPipeline(kind)
    .map(c => ({ ...c, jobs: listJobsForCompany(c.id) }));
  res.json({ count: list.length, kind, companies: list });
});

router.get('/companies/:id', (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ...c, jobs: listJobsForCompany(c.id) });
});

router.patch('/companies/:id', (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const { status, notes, user_rating } = req.body || {};

  if (status !== undefined) {
    const allowed = ['none', 'interested', 'applied', 'skipped'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    setCompanyStatus(c.id, status);
  }
  if (notes !== undefined) setCompanyNotes(c.id, String(notes));
  if (user_rating !== undefined) {
    const r = parseInt(user_rating, 10);
    if (Number.isNaN(r) || r < 0 || r > 5) {
      return res.status(400).json({ error: 'user_rating must be 0..5' });
    }
    setCompanyUserRating(c.id, r);
  }

  const updated = getCompany(c.id);
  res.json({ ...updated, jobs: listJobsForCompany(c.id) });
});

router.post('/companies/:id/refresh-jobs', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const jobs = await findJobsForCompany(c, { external: true });
    syncJobsForCompany(c.id, jobs, { ok: true, replace: true });
    const sources = [...new Set(jobs.map(j => j.source).filter(Boolean))];
    res.json({
      company_id: c.id,
      fetched: jobs.length,
      sources,
      jobs: listJobsForCompany(c.id),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Lazy enrichment: contact scan (fast, background) or full scan (team, jobs, LinkedIn).
router.post('/companies/:id/enrich', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const depth = req.query.depth === 'full' ? 'full' : 'contact';
  try {
    const enriched = await enrichCompany(c, { mode: depth });
    if (!enriched.fetched) {
      updateEnrichment(c.id, {
        fetched: false,
        fetch_error: enriched.fetch_error || 'Could not reach website',
      });
      const partial = getCompany(c.id);
      return res.json({ ...partial, jobs: listJobsForCompany(c.id), enrich_failed: true });
    }

    const cls = classify({ name: c.name, type: c.type, extraText: enriched.extraText });
    const opps = inferOpportunities({ name: c.name, type: c.type });
    upsertCompany({ ...c, ...cls, opportunities: opps.length ? opps : c.opportunities || [] });

    if (depth === 'full') {
      let team = sanitizeTeam(enriched.team || []);
      team = team.map(m => ({
        ...m,
        linkedin_source: m.linkedin_url ? (m.linkedin_source || 'website') : null,
      }));

      const linkedinCo = enriched.socials?.linkedin || c.socials?.linkedin || '';
      if (team.length > 0 && team.length < 8) {
        const discovered = await discoverCompanyPeople({
          name: c.name,
          address: c.address || enriched.address,
          socials: enriched.socials,
        });
        team = mergeTeamMembers(team, discovered);
      }
      if (team.length) {
        team = await resolveTeamLinkedIn(team, c.name, {
          limit: 12,
          linkedinCompanyUrl: linkedinCo,
          address: c.address,
        });
      }
      enriched.team = team;
    } else {
      enriched.enrich_depth = 'contact';
      delete enriched.team;
    }

    updateEnrichment(c.id, enriched);

    const refreshed = getCompany(c.id);
    if (depth === 'full' && (refreshed.careers_url || refreshed.website)) {
      try {
        const jobs = await findJobsForCompany(refreshed, { external: true });
        syncJobsForCompany(c.id, jobs, { ok: true, replace: true });
      } catch (jobErr) {
        console.warn('[enrich] job fetch failed:', c.name, jobErr.message);
      }
    }

    const final = getCompany(c.id);
    res.json({ ...final, jobs: listJobsForCompany(c.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Resolve LinkedIn URLs for the company's team. Runs the DuckDuckGo
// site:linkedin.com/in/ lookup for every team member that doesn't already
// have one cached and writes the results back into the DB.
//
//   POST /api/companies/:id/team-linkedin
//   body (optional): { onlyTop: 5 }  // only resolve top N seniors
router.post('/companies/:id/team-linkedin', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  let team = sanitizeTeam(getTeam(c.id) || []);
  if (!team.length) {
    const discovered = await discoverCompanyPeople(c);
    team = mergeTeamMembers([], discovered);
  }

  const resolved = await resolveTeamLinkedIn(team, c.name, {
    limit: Math.max(0, Math.min(parseInt(req.body?.onlyTop, 10) || 12, team.length || 12)),
    linkedinCompanyUrl: c.socials?.linkedin || '',
    address: c.address,
  });
  updateTeam(c.id, resolved);
  res.json({ team: resolved });
});

// Discover people who work at this company via LinkedIn web search.
//   POST /api/companies/:id/discover-people
router.post('/companies/:id/discover-people', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const existing = sanitizeTeam(getTeam(c.id) || []);
  const discovered = await discoverCompanyPeople(c, {
    limit: Math.min(parseInt(req.body?.limit, 10) || 12, 20),
  });
  let team = mergeTeamMembers(existing, discovered);
  if (team.length) {
    team = await resolveTeamLinkedIn(team, c.name, {
      limit: 12,
      linkedinCompanyUrl: c.socials?.linkedin || '',
      address: c.address,
    });
  }
  updateTeam(c.id, team);
  res.json({ team, discovered: discovered.length, added: team.length - existing.length });
});

// Re-verify contact email on website + DNS before direct send.
router.post('/companies/:id/verify-email', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const check = await verifyCompanyEmail(c);
    if (check.verified && check.email) {
      setCompanyEmail(c.id, {
        email: check.email,
        email_source: check.email_source || c.email_source,
        email_verified: true,
      });
    } else if (check.email) {
      setCompanyEmail(c.id, {
        email: check.email,
        email_source: check.email_source || c.email_source,
        email_verified: false,
      });
    }
    const updated = getCompany(c.id);
    res.json({ ...check, company: { ...updated, jobs: listJobsForCompany(c.id) } });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Generate multiple creative outreach drafts (AI if OPENAI_API_KEY set, else templates).
router.post('/companies/:id/generate-emails', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const profile = req.body?.profile || {};
  try {
    const { variants, ai, fallback } = await generateAiVariants(c, profile, {
      count: Math.min(parseInt(req.body?.count, 10) || 4, 6),
    });
    res.json({ variants, ai, fallback: !!fallback, count: variants.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Send outreach directly — only to verified company emails.
router.post('/companies/:id/send-email', async (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  if (!c.email_verified || !c.email) {
    return res.status(400).json({
      error: 'Email not verified — run Verify email before sending.',
    });
  }

  if (!smtpConfigured()) {
    return res.status(503).json({
      error: 'SMTP not configured — add SMTP_HOST, SMTP_USER, SMTP_PASS to .env',
    });
  }

  const { subject, body, fromName, fromEmail } = req.body || {};
  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }
  if (!fromEmail && !process.env.SMTP_FROM) {
    return res.status(400).json({ error: 'Add your email in Profile → Your email (for sending)' });
  }

  try {
    const result = await sendOutreachEmail({
      to: c.email,
      subject,
      body,
      fromName: fromName || 'AreaHunt user',
      fromEmail,
      replyTo: fromEmail,
    });
    res.json({ ok: true, ...result, to: c.email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.patch('/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'bad id' });
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'not found' });

  const { applied } = req.body || {};
  if (applied !== undefined) setJobApplied(id, !!applied);

  res.json(getJob(id));
});

module.exports = router;
