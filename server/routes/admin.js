// Admin view — analytics + tunable scan settings.
//
// Single-user tool (per the actual scope of this app), so this is just a
// second view for the one real account rather than a real permission
// system — any signed-in session can see it, same as the rest of the app.
//
//   GET /api/admin/stats
//   GET /api/admin/settings
//   PUT /api/admin/settings   body: { key, value }

const express = require('express');
const { getScanStats, getStatusCounts, getJobQualityStats, getAiFitUsageStats } = require('../db');
const { getLearningStats } = require('../services/matchLearningService');
const { getSettingsWithMeta, updateSetting } = require('../services/settingsService');

const router = express.Router();

router.get('/stats', (req, res) => {
  res.json({
    scans: getScanStats(),
    pipeline: getStatusCounts(),
    job_quality: getJobQualityStats(),
    ai_fit: getAiFitUsageStats(),
    learning: getLearningStats(),
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

module.exports = router;
