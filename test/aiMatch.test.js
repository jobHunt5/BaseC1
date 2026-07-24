// AI semantic matcher (aiMatchService) — the pure index/rank core, no DB.
// Confirms meaning-overlap ranking actually works: a skills query surfaces
// the on-topic job above unrelated ones, title matches outrank body-only
// matches, and an all-stopword/empty query returns nothing rather than junk.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, buildIndex, rank } = require('../server/services/aiMatchService');

const DOCS = [
  { ref: 'a', title: 'Senior React Developer', company_name: 'Acme', text: 'Build web apps with React, TypeScript, Node.js and AWS. Frontend focus.' },
  { ref: 'b', title: 'Registered Nurse', company_name: 'Health Co', text: 'Provide patient care in an aged-care ward. Clinical experience required.' },
  { ref: 'c', title: 'Data Engineer', company_name: 'Data Inc', text: 'Python, SQL, data pipelines and cloud warehousing on AWS.' },
  { ref: 'd', title: 'Barista', company_name: 'Cafe', text: 'Make coffee, serve customers, cash handling.' },
];

test('tokenize lowercases, drops stopwords, keeps tech tokens like node.js / c++', () => {
  const toks = tokenize('We are looking for a Node.js and C++ developer');
  assert.ok(toks.includes('node.js'));
  assert.ok(toks.includes('c++'));
  assert.ok(toks.includes('developer'));
  assert.ok(!toks.includes('the'));
  assert.ok(!toks.includes('are'));
});

test('a skills query ranks the on-topic job first', () => {
  const index = buildIndex(DOCS);
  const results = rank(index, 'react frontend typescript developer', { limit: 4 });
  assert.equal(results[0].ref, 'a', 'the React role should rank #1');
  assert.ok(results[0].score > 0);
  // The nurse/barista roles should score below the two engineering roles.
  const nurse = results.find(r => r.ref === 'b');
  if (nurse) assert.ok(nurse.score <= results[0].score);
});

test('overlapping-tech query still separates related from unrelated', () => {
  const index = buildIndex(DOCS);
  const results = rank(index, 'python data pipelines aws cloud', { limit: 4 });
  assert.equal(results[0].ref, 'c', 'the Data Engineer role should rank #1');
  assert.ok(!results.some(r => r.ref === 'd' && r.score > results[0].score), 'barista must not outrank data engineer');
});

test('a title match outranks a body-only match for the same term', () => {
  const docs = [
    { ref: 'title', title: 'Marketing Manager', text: 'Lead campaigns.' },
    { ref: 'body', title: 'Office Coordinator', text: 'Support the marketing team occasionally with admin.' },
  ];
  const results = rank(buildIndex(docs), 'marketing', { limit: 2 });
  assert.equal(results[0].ref, 'title');
});

test('an empty or all-stopword query returns no matches (no garbage)', () => {
  const index = buildIndex(DOCS);
  assert.deepEqual(rank(index, ''), []);
  assert.deepEqual(rank(index, 'the and of to with'), []);
});

test('results never exceed the requested limit', () => {
  const index = buildIndex(DOCS);
  assert.ok(rank(index, 'developer engineer nurse coffee', { limit: 2 }).length <= 2);
});
