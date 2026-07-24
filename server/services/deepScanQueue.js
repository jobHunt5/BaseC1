// Background deep-scan queue — contact + jobs + LinkedIn after map scan.
const { getCompany, updateEnrichment, updateScrapeStatus, syncJobsForCompany, upsertCompany } = require('../db');
const { enrichCompany } = require('./enrichService');
const { findJobsForCompany } = require('./jobsService');
const { classify, inferOpportunities } = require('./classifyService');
const { BOARD_JOB_SOURCES } = require('./trustService');
const {
  resolveTeamLinkedIn,
  discoverCompanyPeople,
  mergeTeamMembers,
  sanitizeTeam,
} = require('./linkedinService');

// Read live (not cached at module load) — settingsService.js applies admin
// overrides onto process.env at runtime, and a module-level const here
// would freeze whatever value was set at require() time, silently ignoring
// any later change until the process restarts.
// Default lowered 4→2: each company's deep scan now also fetches full job
// postings (jobDetailService), so peak memory per in-flight company is
// higher — 4-wide crawling contributed to the 512MB free-tier OOM loop.
function concurrency() { return parseInt(process.env.DEEP_SCAN_CONCURRENCY || '2', 10); }

const queue = [];
let active = 0;

function enqueueDeepScan(companyId, { priority = false } = {}) {
  const id = String(companyId);
  if (queue.some(q => q.id === id)) return;
  const item = { id, at: Date.now() };
  if (priority) queue.unshift(item);
  else queue.push(item);
  pump();
}

function enqueueMany(companyIds) {
  for (const id of companyIds || []) enqueueDeepScan(id);
}

async function pump() {
  while (active < concurrency() && queue.length) {
    const { id } = queue.shift();
    active++;
    runDeepScan(id)
      .catch(err => console.warn('[deep-scan] failed:', id, err.message))
      .finally(() => { active--; pump(); });
  }
}

async function runDeepScan(companyId) {
  const c = await getCompany(companyId);
  if (!c?.website) return;

  const enriched = await enrichCompany(c, { mode: 'full' });
  if (!enriched.fetched) {
    await updateEnrichment(c.id, {
      fetched: false,
      fetch_error: enriched.fetch_error || 'Could not reach website',
    });
    await updateScrapeStatus(c.id, { status: 'failed' });
    return;
  }

  const cls = classify({ name: c.name, type: c.type, extraText: enriched.extraText });
  const opps = inferOpportunities({ name: c.name, type: c.type });
  await upsertCompany({ ...c, ...cls, opportunities: opps.length ? opps : c.opportunities || [] });

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
  enriched.enrich_depth = 'full';
  await updateEnrichment(c.id, enriched);

  const refreshed = await getCompany(c.id);
  if (refreshed.careers_url || refreshed.website) {
    try {
      const jobs = await findJobsForCompany(refreshed, { external: true });
      await syncJobsForCompany(c.id, jobs, { ok: true });
      const atsSource = jobs.find(j => j.source && j.source !== 'careers-page' && !BOARD_JOB_SOURCES.has(j.source));
      await updateScrapeStatus(c.id, {
        status: jobs.length ? 'ok' : 'partial',
        ats: atsSource ? atsSource.source : null,
      });
    } catch (jobErr) {
      console.warn('[deep-scan] jobs failed:', c.name, jobErr.message);
      await updateScrapeStatus(c.id, { status: 'failed' });
    }
  } else {
    // Enriched fine, but there's nothing to scrape jobs from at all.
    await updateScrapeStatus(c.id, { status: 'partial' });
  }
}

function queueStats() {
  return { queued: queue.length, active, concurrency: concurrency() };
}

module.exports = {
  enqueueDeepScan,
  enqueueMany,
  runDeepScan,
  queueStats,
};
