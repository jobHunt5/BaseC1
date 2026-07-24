// Admin API — analytics across every user, tunable scan settings, and real
// user management (list/view/suspend/delete). Gated by adminAuth.js's
// separate admin token, not the per-user dummy auth in auth.js.
//
//   GET    /api/admin/stats            -> global scan/pipeline/quality/config stats
//   GET    /api/admin/analytics        -> time series + breakdowns for the dashboard charts
//   GET    /api/admin/settings         -> tunable scan defaults
//   PUT    /api/admin/settings         body: { key, value }
//   GET    /api/admin/users            -> every user + their pipeline counts
//   GET    /api/admin/users/:id        -> one user's profile + learning insights
//   PATCH  /api/admin/users/:id        body: { suspended: true|false }
//   DELETE /api/admin/users/:id        -> removes the user and all their data

const express = require('express');
const {
  getScanStats, getStatusCounts, getJobQualityStats, getAiFitUsageStats,
  getAllUsersWithStats, getUserById, setUserSuspended, deleteUser, getAnalytics,
  recordAdminAction, getAdminActions,
} = require('../db');
const { getLearningStats } = require('../services/matchLearningService');
const { getSettingsWithMeta, updateSetting } = require('../services/settingsService');
const { buildTrainingExport } = require('../services/trainingExportService');
const aiMatch = require('../services/aiMatchService');
const aiAnalyst = require('../services/aiAnalystService');
const { getAdminFromRequest } = require('./adminAuth');
const {
  status: getSerperStatus, getUsageToday: getSerperUsage, budgetLimit: getSerperBudget,
} = require('../services/serperClient');

const router = express.Router();

router.use((req, res, next) => {
  if (!getAdminFromRequest(req)) return res.status(401).json({ error: 'Not signed in as admin' });
  next();
});

router.get('/stats', async (req, res) => {
  const [scans, pipeline, jobQuality, aiFit, users] = await Promise.all([
    getScanStats(), getStatusCounts(), getJobQualityStats(), getAiFitUsageStats(), getAllUsersWithStats(),
  ]);
  res.json({
    scans,
    pipeline,
    job_quality: jobQuality,
    ai_fit: aiFit,
    user_count: users.length,
    config: {
      places_provider: process.env.PLACES_PROVIDER || 'osm',
      has_google_key: !!process.env.GOOGLE_MAPS_API_KEY,
      has_serper_key: !!process.env.SERPER_API_KEY,
      has_openai_key: !!process.env.OPENAI_API_KEY,
      has_smtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      serper_state: getSerperStatus().state,
      serper_message: getSerperStatus().message,
      serper_usage_today: getSerperUsage(),
      serper_daily_budget: getSerperBudget(),
    },
  });
});

router.get('/analytics', async (req, res) => {
  res.json(await getAnalytics(req.query.days));
});

router.get('/settings', (req, res) => {
  res.json({ settings: getSettingsWithMeta() });
});

router.put('/settings', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const settings = updateSetting(key, value);
    await recordAdminAction('setting_updated', key, `-> ${value}`, req.ip);
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/audit-log', async (req, res) => {
  res.json({ actions: await getAdminActions(200) });
});

// Anonymized, opt-in-only preference-weight export for model training — see
// trainingExportService.js for exactly what is (and, more importantly,
// isn't) included. Computed live on every call, nothing stored.
router.get('/training-export', async (req, res) => {
  const data = await buildTrainingExport();
  res.set('Content-Disposition', `attachment; filename="training-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

// ---- AI layer: semantic job matching ------------------------------------
//   GET /api/admin/ai/status          -> matcher backend + corpus size
//   GET /api/admin/ai/match?q=&limit= -> jobs ranked by meaning-overlap

router.get('/ai/status', async (req, res) => {
  try {
    const status = await aiMatch.status();
    // Whether the real LLM reasoning layer is switched on (needs an API key).
    status.llm_reasoning = aiAnalyst.hasKey();
    status.llm_model = aiAnalyst.hasKey() ? aiAnalyst.model() : null;
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai/match', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 2000);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  if (!q) return res.status(400).json({ error: 'q (a skills/profile query) is required' });
  try {
    res.json({ query: q, ...(await aiMatch.matchJobs(q, { limit })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real LLM reasoning over the retrieved shortlist. Dormant (available:false)
// until OPENAI_API_KEY is set on the server.
router.get('/ai/analyze', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 2000);
  if (!q) return res.status(400).json({ error: 'q (a candidate description) is required' });
  try {
    res.json({ query: q, ...(await aiAnalyst.analyze(q, { limit: 8 })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', async (req, res) => {
  res.json({ users: await getAllUsersWithStats() });
});

router.get('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user, learning: await getLearningStats(user.id) });
});

router.patch('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { suspended } = req.body || {};
  if (suspended === undefined) return res.status(400).json({ error: 'suspended required' });
  await setUserSuspended(user.id, !!suspended);
  await recordAdminAction(suspended ? 'user_suspended' : 'user_unsuspended', user.email, null, req.ip);
  res.json({ user: await getUserById(user.id) });
});

router.delete('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  await deleteUser(user.id);
  await recordAdminAction('user_deleted', user.email, null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
