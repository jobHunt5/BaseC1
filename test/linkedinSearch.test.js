// How the app links a user to find a person on LinkedIn. A user hit the real
// failure this guards against: the /people/ tab + a full postal address in
// the query returned "No results found" for someone findable by hand. The
// fix — general /all/ search, name + company only — is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { searchUrl, companyPeopleSearchUrl } = require('../server/services/linkedinService');

const ADDRESS = '4/756 Blackburn Rd, Clayton VIC 3168, Australia';

test('person search uses the general /all/ page, not the strict /people/ tab', () => {
  const url = searchUrl('Neil Zumpo', 'eccoCONSULTANTS', ADDRESS);
  assert.match(url, /\/search\/results\/all\//);
  assert.doesNotMatch(url, /\/people\//, 'the /people/ tab hard-filters to zero for non-connections');
});

test('person query is name + company only — no address tokens', () => {
  const keywords = decodeURIComponent(new URL(searchUrl('Neil Zumpo', 'eccoCONSULTANTS', ADDRESS)).searchParams.get('keywords'));
  assert.equal(keywords, 'Neil Zumpo eccoCONSULTANTS');
  // The exact tokens that tanked the real search to zero must be gone.
  for (const token of ['Clayton', 'VIC', '3168', 'Victoria', 'Australia', 'Blackburn']) {
    assert.ok(!keywords.includes(token), `address token "${token}" must not be in the query`);
  }
});

test('missing company degrades to a name-only search, still valid', () => {
  const keywords = decodeURIComponent(new URL(searchUrl('Jane Smith', '', ADDRESS)).searchParams.get('keywords'));
  assert.equal(keywords, 'Jane Smith');
});

test('company people search keys on the company name alone', () => {
  const url = companyPeopleSearchUrl('eccoCONSULTANTS', ADDRESS);
  assert.match(url, /\/search\/results\/all\//);
  assert.equal(decodeURIComponent(new URL(url).searchParams.get('keywords')), 'eccoCONSULTANTS');
});
