require('dotenv').config();

const path = require('path');
const express = require('express');

const authRoute = require('./routes/auth');
const scanRoute = require('./routes/scan');
const companiesRoute = require('./routes/companies');
const { getProvider, getCoverageHint } = require('./services/placesService');
const { repairOpportunityTargetClassification, repairBogusScrapedJobs, repairBogusTeamMembers } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve the front end from /public.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  const hasGoogleKey = !!process.env.GOOGLE_MAPS_API_KEY;
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
    enrichLimit: parseInt(process.env.ENRICH_LIMIT || '0', 10) || null,
    enrichConcurrency: parseInt(process.env.ENRICH_CONCURRENCY || '6', 10),
    supportedAts: ['greenhouse', 'lever', 'workable', 'ashby'],
    trustMode: 'verified-only',
    hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    hasSmtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    version: '0.3.0',
  });
});

app.use('/api/auth', authRoute);
app.use('/api/scan', scanRoute);
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
});
