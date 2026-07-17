require('dotenv').config();

const path = require('path');
const express = require('express');

const authRoute = require('./routes/auth');
const scanRoute = require('./routes/scan');
const companiesRoute = require('./routes/companies');
const aiRoute = require('./routes/ai');
const adminRoute = require('./routes/admin');
const adminAuthRoute = require('./routes/adminAuth');
const { getProvider, getCoverageHint } = require('./services/placesService');
const { applyToProcessEnv } = require('./services/settingsService');
const { repairOpportunityTargetClassification, repairBogusScrapedJobs, repairBogusTeamMembers } = require('./db');
const { warmup: warmupPdfEngine } = require('./services/resumeService');
const {
  status: serperStatus, getUsageToday: getSerperUsageToday, budgetLimit: getSerperBudgetLimit,
} = require('./services/serperClient');

// Any settings an admin has previously changed override the .env defaults
// from here on — before anything else touches process.env.
applyToProcessEnv();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve the front end from /public.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Separate admin page — its own HTML/login, not part of the user app bundle.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/api/health', (req, res) => {
  const hasGoogleKey = !!process.env.GOOGLE_MAPS_API_KEY;
  const serper = serperStatus();
  res.json({
    ok: true,
    provider: getProvider(),
    configuredProvider: process.env.PLACES_PROVIDER || 'osm',
    hasGoogleKey,
    sparseCoverage: !hasGoogleKey,
    coverageHint: getCoverageHint(),
    hasSerperKey: !!process.env.SERPER_API_KEY,
    linkedinAutoLookup: !!process.env.SERPER_API_KEY,
    externalJobSearch: !!process.env.SERPER_API_KEY,
    serperState: serper.state,
    serperMessage: serper.message,
    serperUsageToday: getSerperUsageToday(),
    serperDailyBudget: getSerperBudgetLimit(),
    enrichLimit: parseInt(process.env.ENRICH_LIMIT || '0', 10) || null,
    enrichConcurrency: parseInt(process.env.ENRICH_CONCURRENCY || '6', 10),
    supportedAts: ['greenhouse', 'lever', 'workable', 'ashby', 'jobadder'],
    trustMode: 'verified-first',
    deepScanQueue: true,
    hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    hasSmtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    version: '0.3.0',
  });
});

// More specific mount paths must be registered before the catch-all '/api'
// mount below — companiesRoute's own router.use(requireUser) gate has no
// path filter, so if it were registered first it would intercept and
// short-circuit every /api/* request (including /api/admin-auth/login)
// before Express ever reached these more specific routers.
app.use('/api/auth', authRoute);
app.use('/api/scan', scanRoute);
app.use('/api/ai', aiRoute);
app.use('/api/admin-auth', adminAuthRoute);
app.use('/api/admin', adminRoute);
app.use('/api', companiesRoute);

// Last-resort error handler so the front end never sees a hanging request.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = parseInt(process.env.PORT || '5174', 10);
app.listen(PORT, () => {
  repairOpportunityTargetClassification();
  repairBogusScrapedJobs();
  repairBogusTeamMembers();
  const provider = getProvider();
  console.log(`AreaHunt running on http://localhost:${PORT}`);
  console.log(`Places provider: ${provider}${provider === 'google' && !process.env.GOOGLE_MAPS_API_KEY ? '  (WARNING: no GOOGLE_MAPS_API_KEY set)' : ''}`);
  warmupPdfEngine();
});
