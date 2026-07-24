// Anonymized, opt-in-only training-data export — pseudonym stability/
// one-wayness, consent gating, shape (never raw PII), and the "delete your
// account and you're immediately gone" guarantee that the always-live
// (never-stored) design is supposed to deliver.

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db.js');
const { pseudonymFor, buildTrainingExport } = require('../server/services/trainingExportService');

before(async () => {
  await db.ready;
});

test('pseudonymFor is stable and never reveals the raw user id', () => {
  const id = 'user:abcdef1234567890';
  const a = pseudonymFor(id);
  const b = pseudonymFor(id);
  assert.equal(a, b, 'same input should produce the same pseudonym every time');
  assert.match(a, /^[a-f0-9]{16}$/, 'expected a fixed-length hex pseudonym');
  assert.ok(!a.includes('abcdef1234567890'), 'pseudonym must not contain the raw user id');
  assert.notEqual(pseudonymFor('user:someone-else'), a, 'different users must get different pseudonyms');
});

const TEST_ID = Date.now();
const CONSENTING_USER_ID = `test:training-consent-yes-${TEST_ID}`;
const NON_CONSENTING_USER_ID = `test:training-consent-no-${TEST_ID}`;
const CONSENTING_EMAIL = `training_consent_yes_${TEST_ID}@example.com`;
const NON_CONSENTING_EMAIL = `training_consent_no_${TEST_ID}@example.com`;

after(async () => {
  await db.pool.query('DELETE FROM learned_weights WHERE user_id = ANY($1)', [[CONSENTING_USER_ID, NON_CONSENTING_USER_ID]]);
  await db.pool.query('DELETE FROM users WHERE id = ANY($1)', [[CONSENTING_USER_ID, NON_CONSENTING_USER_ID]]);
});

test('buildTrainingExport only includes consenting users, never raw PII fields', async () => {
  await db.upsertUser({ id: CONSENTING_USER_ID, email: CONSENTING_EMAIL, profile: { name: 'Should Not Appear', skills: ['design'] } });
  await db.upsertUser({ id: NON_CONSENTING_USER_ID, email: NON_CONSENTING_EMAIL, profile: { name: 'Also Should Not Appear', skills: ['design'] } });
  await db.setTrainingDataConsent(CONSENTING_USER_ID, true);
  // NON_CONSENTING_USER_ID deliberately left at the default (off).

  await db.setLearnedWeight(CONSENTING_USER_ID, 'industry:design', 0.6, 5);
  await db.setLearnedWeight(NON_CONSENTING_USER_ID, 'industry:design', -0.4, 5);

  const exportData = await buildTrainingExport();
  const consentingPseudonym = pseudonymFor(CONSENTING_USER_ID);
  const nonConsentingPseudonym = pseudonymFor(NON_CONSENTING_USER_ID);

  const subjectIds = exportData.subjects.map(s => s.subject_id);
  assert.ok(subjectIds.includes(consentingPseudonym), 'consenting user should be included');
  assert.ok(!subjectIds.includes(nonConsentingPseudonym), 'non-consenting user should be excluded');

  const consentingSubject = exportData.subjects.find(s => s.subject_id === consentingPseudonym);
  assert.deepEqual(Object.keys(consentingSubject).sort(), ['events', 'features', 'subject_id']);
  for (const f of consentingSubject.features) {
    assert.deepEqual(Object.keys(f).sort(), ['feature_key', 'sample_count', 'weight']);
  }

  // Never any raw PII anywhere in the serialized export.
  const serialized = JSON.stringify(exportData);
  assert.ok(!serialized.includes('Should Not Appear'), 'export must never contain profile name text');
  assert.ok(!serialized.includes(CONSENTING_EMAIL), 'export must never contain an email address');
  assert.ok(!serialized.includes(CONSENTING_USER_ID), 'export must never contain the raw user id');
});

const CORPUS_COMPANY_ID = `test:training-corpus-co-${TEST_ID}`;
const EVENTS_USER_ID = `test:training-events-${TEST_ID}`;
const EVENTS_EMAIL = `training_events_${TEST_ID}@example.com`;
const DAY_MS = 24 * 60 * 60 * 1000;

after(async () => {
  await db.pool.query('DELETE FROM interactions WHERE user_id = $1', [EVENTS_USER_ID]);
  await db.pool.query('DELETE FROM companies WHERE id = $1', [CORPUS_COMPANY_ID]); // cascades jobs
  await db.pool.query('DELETE FROM users WHERE id = $1', [EVENTS_USER_ID]);
});

test('interaction events export day-coarsened and company-generalized, consenting users only', async () => {
  await db.upsertCompany({ id: CORPUS_COMPANY_ID, name: 'Corpus Test Design Studio', lat: -37.81, lng: 144.96, cats: ['design'], type: 'Design agency' });
  await db.upsertUser({ id: EVENTS_USER_ID, email: EVENTS_EMAIL, profile: { name: 'Events Person' } });
  await db.setTrainingDataConsent(EVENTS_USER_ID, true);
  await db.recordInteraction(EVENTS_USER_ID, CORPUS_COMPANY_ID, 'saved');

  const exportData = await buildTrainingExport();
  const subject = exportData.subjects.find(s => s.subject_id === pseudonymFor(EVENTS_USER_ID));
  assert.ok(subject, 'consenting user with an interaction appears');
  assert.equal(subject.events.length, 1);
  const ev = subject.events[0];
  assert.deepEqual(Object.keys(ev).sort(), ['action', 'company_cats', 'company_type', 'day']);
  assert.equal(ev.action, 'saved');
  assert.deepEqual(ev.company_cats, ['design']);
  assert.equal(ev.day % DAY_MS, 0, 'timestamp must be coarsened to day granularity');

  // The specific company must not be identifiable from the export.
  const serialized = JSON.stringify(exportData.subjects);
  assert.ok(!serialized.includes(CORPUS_COMPANY_ID), 'company id must never appear in subjects');
  assert.ok(!serialized.includes('Corpus Test Design Studio'), 'company name must never appear in subjects');
});

test('job corpus exports full posting content without company identity, no consent gate needed', async () => {
  await db.syncJobsForCompany(CORPUS_COMPANY_ID, [{
    title: 'Product Designer', url: 'https://example.com/jobs/pd',
    description: 'short snippet', description_full: 'Full posting body '.repeat(50),
    salary: 'A$110k–A$130k/year', job_type: 'FULL_TIME', detail_status: 'full',
  }]);

  const exportData = await buildTrainingExport();
  const row = exportData.job_corpus.find(j => j.title === 'Product Designer');
  assert.ok(row, 'job with a description appears in the corpus');
  assert.ok(row.description.length > 500, 'corpus carries the FULL description');
  assert.deepEqual(row.company_cats, ['design'], 'company reduced to categories');
  assert.equal(row.company_id, undefined, 'no company id in the corpus');
  assert.ok(!JSON.stringify(exportData.job_corpus).includes(CORPUS_COMPANY_ID));
  assert.ok(Array.isArray(exportData.area_job_corpus), 'area corpus section present');
});

test('deleting a consenting user removes them from the next export immediately (no stored snapshot lingers)', async () => {
  const pseudonym = pseudonymFor(CONSENTING_USER_ID);
  let exportData = await buildTrainingExport();
  assert.ok(exportData.subjects.some(s => s.subject_id === pseudonym), 'sanity check: still present before deletion');

  await db.deleteUser(CONSENTING_USER_ID);

  exportData = await buildTrainingExport();
  assert.ok(!exportData.subjects.some(s => s.subject_id === pseudonym), 'deleted user must be gone from the very next export');
});
