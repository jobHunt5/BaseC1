require('dotenv').config();

// Initialized before every other require so Sentry's auto-instrumentation
// (http, etc.) can hook in as early as possible. Optional — the app runs
// fine with error reporting simply off when SENTRY_DSN isn't set.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const authRoute = require('./routes/auth');
const scanRoute = require('./routes/scan');
const companiesRoute = require('./routes/companies');
const aiRoute = require('./routes/ai');
const adminRoute = require('./routes/admin');
const adminAuthRoute = require('./routes/adminAuth');
const { getProvider, getCoverageHint } = require('./services/placesService');
const { applyToProcessEnv } = require('./services/settingsService');
const db = require('./db');
const { repairOpportunityTargetClassification, repairBogusScrapedJobs, repairBogusTeamMembers } = db;
const { warmup: warmupPdfEngine } = require('./services/resumeService');
const { enqueueMany } = require('./services/deepScanQueue');
const { runJobAlertsCheck } = require('./services/jobAlertService');
const {
  status: serperStatus, getUsageToday: getSerperUsageToday, budgetLimit: getSerperBudgetLimit,
} = require('./services/serperClient');

const app = express();
// Render (and most PaaS hosts) put the app behind a reverse proxy — without
// this, req.ip is the proxy's own address for every request, which quietly
// breaks IP-based rate limiting (every user collapses into one bucket).
app.set('trust proxy', 1);

// CSP allows exactly the CDN origins the app actually loads (Leaflet from
// cdnjs/unpkg, map tiles from cartocdn) plus 'unsafe-inline' scripts — the
// whole frontend is built on inline onclick="App.x()" handlers, and ripping
// those out to satisfy a stricter CSP is a real rewrite, not a pre-launch
// hardening pass. Still meaningfully blocks a script-injection payload from
// pulling in code from anywhere OTHER than these known origins.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      // Separate from scriptSrc under CSP3 — helmet's default is 'none' for
      // this one specifically, which silently blocks every inline
      // onclick="..." attribute in the app (the primary interaction pattern
      // used almost everywhere) even with scriptSrc allowing 'unsafe-inline'.
      // Missed in the original pass because the one thing tested by hand
      // (the login button) happens to use an assigned .onclick property,
      // not an inline attribute — everything else in the app does.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
      fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      objectSrc: ["'none'"],
      // Same family of problem as HSTS below — this tells the browser to
      // rewrite http:// sub-resource requests to https://, which is a
      // no-op on a real HTTPS deployment but pure risk on local HTTP dev
      // (no upside, and one less thing to rule out if a similar symptom
      // ever shows up again). `null` removes the directive from the
      // generated header entirely instead of using helmet's default.
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  // The admin/user pages don't embed third-party frames of their own and
  // aren't meant to be embedded either — crossOriginEmbedderPolicy off
  // avoids breaking the Leaflet tile fetches, which is the one helmet
  // default that conflicts with this app's actual cross-origin image loads.
  crossOriginEmbedderPolicy: false,
  // HSTS tells the BROWSER to remember "always use HTTPS for this host"
  // for a year, including on plain HTTP responses — sending it from local
  // dev (no TLS at all) poisons the browser into force-upgrading every
  // future localhost:PORT request to HTTPS, which goes nowhere and
  // silently breaks every subsequent asset load (the page loads once,
  // then CSS/JS fail from then on — exactly this bug). Render terminates
  // TLS itself in front of the app, so this only needs to be real once
  // actually deployed.
  hsts: process.env.NODE_ENV === 'production',
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

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
    supportedAts: [
      'greenhouse', 'lever', 'workable', 'ashby', 'jobadder',
      'smartrecruiters', 'recruitee', 'breezy', 'teamtailor', 'bamboohr', 'personio', 'workday',
    ],
    trustMode: 'verified-first',
    deepScanQueue: true,
    // Per-source full-posting fetch reach since boot (Seek/Indeed/LinkedIn…)
    // — the measured answer to "which boards actually let us in from here".
    jobDetailReach: require('./services/jobDetailService').getDetailStats(),
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

if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// Last-resort error handler so the front end never sees a hanging request.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'internal error' });
});

// Settings the admin has previously changed override the .env defaults from
// here on — but that requires the settings table to have loaded first,
// which (against Postgres, unlike the old synchronous better-sqlite3 read)
// is unavoidably async. Exposed as app.ready so both the real boot path
// below and the test suite can wait for it before making requests.
const ready = db.ready.then(() => { applyToProcessEnv(); });
app.ready = ready;

// Only bind a real listener when run directly (`npm start`) — tests
// `require` this file to get `app` and bind their own ephemeral port instead,
// so they never fight the dev server for :5174 or trigger the headless-Chrome
// PDF-engine warmup.
if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '5174', 10);
  ready.then(() => {
    app.listen(PORT, () => {
      const provider = getProvider();
      console.log(`AreaHunt running on http://localhost:${PORT}`);
      console.log(`Places provider: ${provider}${provider === 'google' && !process.env.GOOGLE_MAPS_API_KEY ? '  (WARNING: no GOOGLE_MAPS_API_KEY set)' : ''}`);
      // PDF/Chrome warmup at boot was OOM-killing the 512MB free instance —
      // launching headless Chrome the instant we start listening, on top of
      // the deep-scan re-enqueue below, pushed a cold instance past its
      // memory limit and Render SIGKILL'd it in a ~90s loop. Chrome is now
      // launched lazily on the first real PDF request instead (warmup already
      // fell back to that anyway). Set PDF_WARMUP=1 to re-enable on a plan
      // with more headroom.
      if (process.env.PDF_WARMUP === '1') warmupPdfEngine();

      // One-time data-repair passes — run in the background after the
      // server is already accepting traffic, same as before; errors here
      // shouldn't be able to crash the process or block startup.
      repairOpportunityTargetClassification().catch(err => console.error('[repair]', err));
      repairBogusScrapedJobs().catch(err => console.error('[repair]', err));
      repairBogusTeamMembers().catch(err => console.error('[repair]', err));

      // Re-queue companies that never finished (or never started) a deep
      // scan — the queue is in-memory only, so a restart would otherwise
      // drop it. Deliberately DELAYED and CAPPED: running a 200-company crawl
      // burst during the cold-boot window is what tipped the free instance
      // into an OOM restart loop. Wait for the instance to settle, then
      // enqueue a small batch (each subsequent scan re-triggers the rest).
      // Default 0 (off): even a delayed 25-company crawl burst re-spiked the
      // 512MB free instance into a one-off OOM restart ~90s after each boot.
      // On-demand scans re-enqueue what they touch anyway, so the boot
      // re-crawl is a freshness nicety, not load-bearing. Set BOOT_RESCAN_LIMIT
      // to a positive number on a plan with real memory headroom.
      const bootRescanN = parseInt(process.env.BOOT_RESCAN_LIMIT || '0', 10);
      const bootRescanDelay = parseInt(process.env.BOOT_RESCAN_DELAY_MS || '90000', 10);
      if (bootRescanN > 0) {
        setTimeout(() => {
          db.getCompaniesNeedingRescan(bootRescanN)
            .then(ids => enqueueMany(ids))
            .catch(err => console.error('[deep-scan] boot rescan failed', err));
        }, bootRescanDelay).unref?.();
      }

      // Proactive job-alert digests — checks every 30 min for freshly
      // scraped jobs matching a user's skills in an area they've scanned.
      // Only fires reliably because the existing UptimeRobot health-check
      // monitor keeps this free-plan dyno from idling between requests.
      setInterval(() => {
        runJobAlertsCheck().catch(err => console.error('[job-alerts] check failed', err));
      }, 30 * 60 * 1000);
    });
  });
}

module.exports = app;
