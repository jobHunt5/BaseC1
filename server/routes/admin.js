// Admin API — analytics across every user, tunable scan settings, and real
// user management (list/view/suspend/delete). Gated by adminAuth.js's
// separate admin token, not the per-user dummy auth in auth.js.
//
//   GET    /api/admin/stats            -> global scan/pipeline/quality/config stats
//   GET    /api/admin/settings         -> tunable scan defaults
//   PUT    /api/admin/settings         body: { key, value }
//   GET    /api/admin/users            -> every user + their pipeline counts
//   GET    /api/admin/users/:id        -> one user's profile + learning insights
//   PATCH  /api/admin/users/:id        body: { suspended: true|false }
//   DELETE /api/admin/users/:id        -> removes the user and all their data

const express = require('express');
const {
  getScanStats, getStatusCounts, getJobQualityStats, getAiFitUsageStats,
  getAllUsersWithStats, getUserById, setUserSuspended, deleteUser,
} = require('../db');
const { getLearningStats } = require('../services/matchLearningService');
const { getSettingsWithMeta, updateSetting } = require('../services/settingsService');
const { getAdminFromRequest } = require('./adminAuth');

const router = express.Router();

router.use((req, res, next) => {
  if (!getAdminFromRequest(req)) return res.status(401).json({ error: 'Not signed in as admin' });
  next();
});

router.get('/stats', (req, res) => {
  res.json({
    scans: getScanStats(),
    pipeline: getStatusCounts(),
    job_quality: getJobQualityStats(),
    ai_fit: getAiFitUsageStats(),
    user_count: getAllUsersWithStats().length,
    config: {
      places_provider: process.env.PLACES_PROVIDER || 'osm',
      has_google_key: !!process.env.GOOGLE_MAPS_API_KEY,
      has_serper_key: !!process.env.SERPER_API_KEY,
      has_openai_key: !!process.env.OPENAI_API_KEY,
      has_smtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    },
  });
});

router.get('/settings', (req, res) => {
  res.json({ settings: getSettingsWithMeta() });
});

router.put('/settings', (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const settings = updateSetting(key, value);
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/users', (req, res) => {
  res.json({ users: getAllUsersWithStats() });
});

router.get('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ user, learning: getLearningStats(user.id) });
});

router.patch('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { suspended } = req.body || {};
  if (suspended === undefined) return res.status(400).json({ error: 'suspended required' });
  setUserSuspended(user.id, !!suspended);
  res.json({ user: getUserById(user.id) });
});

router.delete('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  deleteUser(user.id);
  res.json({ ok: true });
});

module.exports = router;
