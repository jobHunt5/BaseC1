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
  listJobsForCompany, jobsGroupedFor, upsertJob, setJobApplied, getJob,
  upsertCompany, updateEnrichment, getTeam, updateTeam,
  syncJobsForCompany, recordInteraction,
} = require('../db');
const { getUserFromRequest } = require('./auth');
const { findJobsForCompany } = require('../services/jobsService');
const { enrichCompany } = require('../services/enrichService');
const { verifyCompanyEmail } = require('../services/emailVerifyService');
const { sendOutreachEmail, smtpConfigured } = require('../services/mailService');
const { generateAiVariants } = require('../services/outreachAiService');
const { classify, inferOpportunities } = require('../services/classifyService');
const { retrainWeights } = require('../services/matchLearningService');
const {
  resolveTeamLinkedIn,
  discoverCompanyPeople,
  mergeTeamMembers,
  sanitizeTeam,
} = require('../services/linkedinService');
const { attachProfile, attachProfiles, buildCompanyProfile } = require('../services/companyProfileService');
const { enqueueDeepScan, runDeepScan, queueStats } = require('../services/deepScanQueue');
const { renderResumePdf } = require('../services/resumeService');
const { renderCoverLetterPdf } = require('../services/coverLetterService');
const { decrypt: decryptSecret } = require('../services/cryptoService');
const { rateLimit, byUser } = require('../services/rateLimit');
const { getGapAnalysis, getRankedSavedCompanies } = require('../services/insightsService');

const router = express.Router();

// PDF generation spins up a real headless-Chrome render per request —
// cheap to abuse into a memory/CPU exhaustion DoS without a cap. Sending
// email and generating AI drafts both cost real money per call (SMTP
// relay reputation, OpenAI tokens) on top of that.
const pdfRateLimit = rateLimit({ max: 10, windowMs: 5 * 60 * 1000, keyFn: byUser });
const sendRateLimit = rateLimit({ max: 20, windowMs: 60 * 60 * 1000, keyFn: byUser });
const aiDraftRateLimit = rateLimit({ max: 30, windowMs: 60 * 60 * 1000, keyFn: byUser });

// Everything here is a signed-in user's own view of the shared discovery
// pool (status/notes/rating/applied are private per user — see db.js),
// so the whole file requires a valid session.
router.use(async (req, res, next) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.suspended) return res.status(403).json({ error: 'Account suspended' });
  req.user = user;
  next();
});

async function withProfile(c, userId) {
  if (!c) return null;
  return attachProfile(c, await listJobsForCompany(c.id, userId), userId);
}

// Build profiles for a whole list using a single batched jobs query, so a
// large scan result doesn't fire thousands of DB round-trips.
async function withProfiles(companies, userId) {
  if (!companies.length) return [];
  const jobsMap = await jobsGroupedFor(companies.map(c => c.id), userId);
  return attachProfiles(companies, jobsMap, userId);
}

router.get('/companies', async (req, res) => {
  const list = await withProfiles(await listAllCompanies(req.user.id), req.user.id);
  res.json({ count: list.length, companies: list });
});

router.get('/companies/in-bounds', async (req, res) => {
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
    return res.status(400).json({ error: 'bbox=south,west,north,east required' });
  }
  const [south, west, north, east] = bbox;
  const list = await withProfiles(await listCompaniesInBounds({ south, west, north, east }, req.user.id), req.user.id);
  res.json({ count: list.length, companies: list });
});

router.get('/companies/pipeline', async (req, res) => {
  const kind = String(req.query.kind || 'interested');
  if (!['interested', 'applied'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be interested or applied' });
  }
  const list = await withProfiles(await listCompaniesByPipeline(kind, req.user.id), req.user.id);
  res.json({ count: list.length, kind, companies: list });
});

router.get('/companies/:id', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await withProfile(c, req.user.id));
});

// Personal job-hunt insights — built entirely from this user's own saved/
// applied companies and their own profile, see insightsService.js.
router.get('/insights', async (req, res) => {
  const ranked = await getRankedSavedCompanies(req.user.id, 'interested');
  const gaps = await getGapAnalysis(req.user.id, req.user.profile);
  res.json({ ranked, gaps });
});

// Unified trust-first profile (jobs, LinkedIn, links, evidence).
router.get('/companies/:id/profile', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await buildCompanyProfile(c, await listJobsForCompany(c.id, req.user.id), req.user.id));
});

// Full background deep scan: website + team + LinkedIn + jobs.
router.post('/companies/:id/deep-scan', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    await runDeepScan(c.id);
    res.json(await withProfile(await getCompany(c.id, req.user.id), req.user.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/deep-scan/status', (req, res) => {
  res.json(queueStats());
});

// Maps a status transition to a learning-signal action. Going TO a status
// is the positive/negative signal; going back to 'none' from one is its
// inverse (undoing a save isn't neutral — it's evidence the initial save
// was a mistake, worth learning from too).
function interactionForTransition(fromStatus, toStatus) {
  if (toStatus === 'interested') return 'saved';
  if (toStatus === 'applied') return 'applied';
  if (toStatus === 'skipped') return 'skipped';
  if (toStatus === 'none') {
    if (fromStatus === 'interested') return 'unsaved';
    if (fromStatus === 'applied') return 'unapplied';
  }
  return null;
}

router.patch('/companies/:id', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const { status, notes, user_rating } = req.body || {};

  if (status !== undefined) {
    const allowed = ['none', 'interested', 'applied', 'skipped'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    if (status !== c.status) {
      const action = interactionForTransition(c.status, status);
      if (action) {
        await recordInteraction(req.user.id, c.id, action);
        // Cheap enough (hundreds of rows, not millions) to just retrain on
        // every interaction rather than on a schedule — scores are always
        // current with the latest save/apply/skip.
        await retrainWeights(req.user.id);
      }
    }
    await setCompanyStatus(req.user.id, c.id, status);
  }
  if (notes !== undefined) await setCompanyNotes(req.user.id, c.id, String(notes));
  if (user_rating !== undefined) {
    const r = parseInt(user_rating, 10);
    if (Number.isNaN(r) || r < 0 || r > 5) {
      return res.status(400).json({ error: 'user_rating must be 0..5' });
    }
    await setCompanyUserRating(req.user.id, c.id, r);
  }

  const updated = await getCompany(c.id, req.user.id);
  res.json(await withProfile(updated, req.user.id));
});

router.post('/companies/:id/refresh-jobs', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const jobs = await findJobsForCompany(c, { external: true });
    await syncJobsForCompany(c.id, jobs, { ok: true, replace: true });
    res.json({
      company_id: c.id,
      fetched: jobs.length,
      sources: [...new Set(jobs.map(j => j.source).filter(Boolean))],
      ...await withProfile(await getCompany(c.id, req.user.id), req.user.id),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Lazy enrichment: contact scan (fast, background) or full scan (team, jobs, LinkedIn).
router.post('/companies/:id/enrich', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const depth = req.query.depth === 'full' ? 'full' : 'contact';
  try {
    const enriched = await enrichCompany(c, { mode: depth });
    if (!enriched.fetched) {
      await updateEnrichment(c.id, {
        fetched: false,
        fetch_error: enriched.fetch_error || 'Could not reach website',
      });
      const partial = await getCompany(c.id, req.user.id);
      return res.json({ ...await withProfile(partial, req.user.id), enrich_failed: true });
    }

    const cls = classify({ name: c.name, type: c.type, extraText: enriched.extraText });
    const opps = inferOpportunities({ name: c.name, type: c.type });
    await upsertCompany({ ...c, ...cls, opportunities: opps.length ? opps : c.opportunities || [] });

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

    await updateEnrichment(c.id, enriched);

    const refreshed = await getCompany(c.id, req.user.id);
    if (depth === 'full' && (refreshed.careers_url || refreshed.website)) {
      try {
        const jobs = await findJobsForCompany(refreshed, { external: true });
        await syncJobsForCompany(c.id, jobs, { ok: true, replace: true });
      } catch (jobErr) {
        console.warn('[enrich] job fetch failed:', c.name, jobErr.message);
      }
    }

    const final = await getCompany(c.id, req.user.id);
    res.json(await withProfile(final, req.user.id));
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
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  let team = sanitizeTeam(await getTeam(c.id) || []);
  if (!team.length) {
    const discovered = await discoverCompanyPeople(c);
    team = mergeTeamMembers([], discovered);
  }

  const resolved = await resolveTeamLinkedIn(team, c.name, {
    limit: Math.max(0, Math.min(parseInt(req.body?.onlyTop, 10) || 12, team.length || 12)),
    linkedinCompanyUrl: c.socials?.linkedin || '',
    address: c.address,
  });
  await updateTeam(c.id, resolved);
  res.json({ team: resolved });
});

// Discover people who work at this company via LinkedIn web search.
//   POST /api/companies/:id/discover-people
router.post('/companies/:id/discover-people', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const existing = sanitizeTeam(await getTeam(c.id) || []);
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
  await updateTeam(c.id, team);
  res.json({ team, discovered: discovered.length, added: team.length - existing.length });
});

// Re-verify contact email on website + DNS before direct send.
router.post('/companies/:id/verify-email', async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const check = await verifyCompanyEmail(c);
    if (check.verified && check.email) {
      await setCompanyEmail(c.id, {
        email: check.email,
        email_source: check.email_source || c.email_source,
        email_verified: true,
      });
    } else if (check.email) {
      await setCompanyEmail(c.id, {
        email: check.email,
        email_source: check.email_source || c.email_source,
        email_verified: false,
      });
    }
    const updated = await getCompany(c.id, req.user.id);
    res.json({ ...check, company: await withProfile(updated, req.user.id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Generate multiple creative outreach drafts (AI if OPENAI_API_KEY set, else templates).
router.post('/companies/:id/generate-emails', aiDraftRateLimit, async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
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

// Send outreach directly — only to verified company emails, only through
// the signed-in user's own sending account (see mailService.js for why:
// a shared account can't honestly claim to be a different per-user From
// address without looking like spoofing to the receiving mail server).
router.post('/companies/:id/send-email', sendRateLimit, async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  if (!c.email_verified || !c.email) {
    return res.status(400).json({
      error: 'Email not verified — run Verify email before sending.',
    });
  }

  const ea = req.user.profile?.emailAccount;
  const account = ea?.appPasswordEnc
    ? { host: ea.host, port: ea.port, user: ea.email, pass: decryptSecret(ea.appPasswordEnc) }
    : null;

  if (!smtpConfigured(account)) {
    return res.status(503).json({
      error: 'Add your sending email account in Profile → Email account before you can send',
    });
  }

  const { subject, body, fromName, attachResume, attachCoverLetter } = req.body || {};
  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }

  try {
    const attachments = [];
    if (attachResume) {
      attachments.push({ filename: 'resume.pdf', content: await renderResumePdf({ ...req.user.profile, email: req.user.email }) });
    }
    if (attachCoverLetter) {
      attachments.push({ filename: `cover-letter-${c.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`, content: await renderCoverLetterPdf({ ...req.user.profile, email: req.user.email }, c) });
    }

    const result = await sendOutreachEmail({
      to: c.email,
      subject,
      body,
      fromName: fromName || req.user.profile?.name || 'AreaHunt user',
      fromEmail: ea?.email,
      replyTo: ea?.email,
      account,
      attachments,
    });
    res.json({ ok: true, ...result, to: c.email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// User's own resume, built from their profile — not company-scoped, but
// lives here since this router already enforces auth and exposes req.user.
router.get('/profile/resume.pdf', pdfRateLimit, async (req, res) => {
  try {
    const pdf = await renderResumePdf({ ...req.user.profile, email: req.user.email });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="resume.pdf"');
    res.send(pdf);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Cover letter personalised to this one company — AI-written when
// OPENAI_API_KEY is set (references the company's own scraped description),
// template fallback otherwise.
router.get('/companies/:id/cover-letter.pdf', pdfRateLimit, async (req, res) => {
  const c = await getCompany(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  try {
    const pdf = await renderCoverLetterPdf({ ...req.user.profile, email: req.user.email }, c);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="cover-letter-${c.id.replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.patch('/jobs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'bad id' });
  const job = await getJob(id, req.user.id);
  if (!job) return res.status(404).json({ error: 'not found' });

  const { applied } = req.body || {};
  if (applied !== undefined) await setJobApplied(req.user.id, id, !!applied);

  res.json(await getJob(id, req.user.id));
});

module.exports = router;
