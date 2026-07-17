// Reject office locations, service cards, and address blocks mistaken for team members.

const PLACE_NAMES = new Set([
  'new south wales', 'victoria', 'queensland', 'western australia',
  'south australia', 'tasmania', 'northern territory', 'australian capital territory',
  'australia', 'new zealand', 'united kingdom', 'united states', 'hong kong',
  'singapore', 'melbourne', 'sydney', 'brisbane', 'perth', 'adelaide',
  'hobart', 'darwin', 'canberra', 'gold coast', 'sunshine coast',
]);

const PLACE_RE = /^(north|south|east|west|central|greater)\s+(sydney|melbourne|brisbane|coast|wales|australia|queensland)$/i;

const ADDRESS_RE = [
  /\b\d{1,4}\s+\w+\s+(st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|way|cres|crescent|parade|pde|court|ct|place|pl)\b/i,
  /\blevel\s+\d+/i,
  /\b(suite|unit|shop)\s+\d+/i,
  /\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\s+\d{4}\b/,
  /\b\d{4}\s*(Australia|AU)\b/i,
  /\bmaps\.(app\.)?goo\.gl\b/i,
  /\bgoogle\.com\/maps\b/i,
  /\bpo box\b/i,
  /\bpostcode\b/i,
];

function isPlaceName(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (PLACE_NAMES.has(lower)) return true;
  if (PLACE_RE.test(t)) return true;
  // "Something Office" / "Head Office" style headings
  if (/\b(office|branch|location|headquarters|hq)\b/i.test(t) && !/\b(of|at)\s+[A-Z]/i.test(t)) return true;
  return false;
}

// Trade / service headings and generic page sections mistaken for people.
const SECTION_HEADING_RE = [
  /^our\s+(services?|products?|solutions?|offerings?|work|clients?|expertise|capabilities|process|approach|values|mission|vision|story|portfolio|projects?)$/i,
  /^the\s+(services?|team|company|business)$/i,
  /^what\s+we\s+(do|offer|provide)$/i,
  /^why\s+(choose|work with)\s+us$/i,
  /^how\s+we\s+(work|help|deliver)$/i,
  /^key\s+(services?|offerings?|features?)$/i,
  /^core\s+(services?|competencies|capabilities)$/i,
];

const SERVICE_NAME_RE = [
  /\b(electrical|electrician|electricians|plumbing|plumber|hvac|air conditioning|heating|cooling)\b/i,
  /\b(repairs?|maintenance|installation|wiring|panels?|outlets?|lighting|conditioning)\b/i,
  /\b(security systems?|power solutions?|data services?)\b/i,
  /\bemergency\s+(electrician|plumber|service|repair)/i,
  /\b(frequently asked questions?|faq)\b/i,
  /\b(get a quote|call us now|view more)\b/i,
  /\b(upgrades?|services?)\s*$/i,
  /\b\w+\s+(repairs?|maintenance|service|upgrades?|solutions?)\s*$/i,
  /\b(mobile apps?|website development|software development|web design|logo design|graphics design)\b/i,
];

const SERVICE_BIO_RE = [
  /\b(call us now|get a quote|view more|learn more|read more|book now)\b/i,
  /\bexpert services for the installation\b/i,
  /\bcomprehensive \w+ solutions?\b/i,
  /\bwhether you['']re a homeowner\b/i,
  /\bensure(?:ing)? (?:the )?(?:safety|convenient access)\b/i,
  /\b(swift and effective solutions for|design and implement|expert guidance|advanced automation)\b/i,
  /\b(tailored to your|your unique business|streamline your|revolutionise your|revolutionize your)\b/i,
  /\b(keep your business|our solutions|license-based pricing|cost savings|additional revenue)\b/i,
  /\b(minimizing disruption|integrate smoothly|integrates smoothly|your capital is precious)\b/i,
  /\b(pay us for|we build solutions that|not the other way around)\b/i,
  /\b(including llm models|ai-driven content|contingency plans enabled)\b/i,
];

const SERVICE_TITLE_RE = [
  /^(view more|learn more|read more|call us now|get a quote|book now)$/i,
  /^call us now get a quote$/i,
];

const SERVICE_MENU_WORDS = [
  'development', 'design', 'apps', 'app', 'website', 'web', 'software', 'mobile',
  'logo', 'graphics', 'graphic', 'marketing', 'seo', 'consulting', 'branding',
  'hosting', 'cloud', 'digital', 'ecommerce', 'e-commerce', 'ui', 'ux',
];

// Capability / offering headings mistaken for people (agencies, IT consultancies).
const OFFERING_JARGON = [
  'software', 'development', 'consulting', 'automation', 'integration',
  'transformation', 'continuity', 'solutions', 'digital', 'custom', 'seamless',
  'process', 'business', 'implementation', 'workflow', 'operations', 'technologies',
  'platform', 'strategy', 'analytics', 'intelligence', 'optimization', 'services',
  'cloud', 'data', 'ai', 'web', 'mobile',
];

const OFFERING_SUFFIX_RE = /\b(development|consulting|solutions?|automation|integration|transformation|continuity|services?|implementation|optimization|strategy)\s*$/i;

function jargonWordCount(text) {
  const lower = String(text || '').toLowerCase();
  let n = 0;
  for (const w of OFFERING_JARGON) {
    if (new RegExp(`\\b${w.replace(/-/g, '[\\-]?')}\\b`, 'i').test(lower)) n++;
  }
  return n;
}

function looksLikeOfferingHeading(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/^your\s+\w+/i.test(t)) return true;
  if (OFFERING_SUFFIX_RE.test(t)) return true;
  if (jargonWordCount(t) >= 2) return true;
  if (jargonWordCount(t) >= 1 && OFFERING_SUFFIX_RE.test(t)) return true;
  return false;
}

function isSectionHeading(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return SECTION_HEADING_RE.some(re => re.test(t));
}

function looksLikeServiceMenu(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 20) return false;
  let hits = 0;
  for (const w of SERVICE_MENU_WORDS) {
    if (new RegExp(`\\b${w.replace(/-/g, '[\\-]?')}\\b`, 'i').test(t)) hits++;
  }
  // Several service keywords run together — a menu of offerings, not a job title.
  if (hits >= 3) return true;
  if (hits >= 2 && t.length > 35 && !/\b(at|of|for|and)\s+[A-Z][a-z]+\b/.test(t)) return true;
  return false;
}

function isServiceName(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 4) return false;
  if (isSectionHeading(t)) return true;
  if (looksLikeOfferingHeading(t)) return true;
  if (SERVICE_NAME_RE.some(re => re.test(t))) return true;
  // "Emergency Electrician Melbourne" — trade + city, not a person.
  if (/\b(emergency|local|licensed|certified)\b/i.test(t) &&
      /\b(electrician|plumber|technician|contractor)s?\b/i.test(t)) {
    return true;
  }
  return false;
}

function looksLikeServiceBio(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 20) return false;
  return SERVICE_BIO_RE.some(re => re.test(t));
}

function looksLikeServiceTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return SERVICE_TITLE_RE.some(re => re.test(t));
}

function looksLikeAddress(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 12) return false;
  if (ADDRESS_RE.some(re => re.test(t))) return true;
  // City + street fragment without being a sentence
  if (/\b(Sydney|Melbourne|Brisbane|Perth|Adelaide|Darlinghurst|Richmond|Parramatta)\b/i.test(t) &&
      /\b\d/.test(t) && t.length < 120) {
    return true;
  }
  return false;
}

// Cookie consent, privacy, and legal banners scraped as fake "people".
const BANNER_NAME_RE = /^(cookie\s*(consent|policy|settings|preferences|notice)?|consent|privacy\s*(policy|notice|settings)?|terms|gdpr|we\s+value\s+your\s+privacy|your\s+privacy|accept\s+(all\s+)?cookies?|manage\s+cookies?|newsletter|subscribe|sign\s*up|log\s*in|sign\s*in|menu|search)$/i;
const BANNER_BIO_RE = /\b(we use cookies|this (website|site) uses cookies|cookies (to|keep|help|are)|by (continuing|clicking|using)|accept (all )?cookies|your (privacy|consent)|personali[sz]e\b.*\b(content|ads|experience)|opt[- ]?out|privacy policy|gdpr|consent to)\b/i;

function looksLikeConsentBanner(member) {
  const name = String(member?.name || '').replace(/\s+/g, ' ').trim();
  if (BANNER_NAME_RE.test(name)) return true;
  const bio = String(member?.bio || '');
  if (BANNER_BIO_RE.test(bio)) return true;
  if (BANNER_BIO_RE.test(member?.title || '')) return true;
  return false;
}

// Positive gate: does this string actually read like a person's name?
// Real names are short, title-cased, mostly alphabetic, and not sentences.
// This generically rejects headings, banners, and marketing blurbs for ANY
// company without needing a phrase-by-phrase denylist.
const HONORIFIC_RE = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|rev)\.?$/i;

// Words that appear in website chrome / headings but are virtually never parts
// of a real person's name. Deliberately excludes common-word surnames/given
// names (Brown, Green, Baker, Cook, Hill, Stone, Mark, Grace, Hope, Rose, …)
// so we don't reject real people. This is a token denylist, not a phrase one,
// so it generalises across every company.
const NON_NAME_TOKENS = new Set([
  // pronouns / function words
  'we', 'our', 'us', 'you', 'your', 'i', 'me', 'my', 'the', 'a', 'an', 'and',
  'or', 'of', 'to', 'for', 'with', 'this', 'that', 'these', 'those', 'it', 'its',
  // web chrome / legal
  'cookie', 'cookies', 'consent', 'privacy', 'policy', 'policies', 'terms',
  'conditions', 'gdpr', 'settings', 'preferences', 'newsletter', 'subscribe',
  'signup', 'login', 'logout', 'register', 'account', 'menu', 'search', 'home',
  'about', 'contact', 'faq', 'faqs', 'questions', 'question', 'frequently',
  'asked', 'help', 'welcome', 'hello', 'overview', 'summary', 'sitemap',
  'copyright', 'reserved', 'rights', 'disclaimer',
  // generic site sections
  'mission', 'vision', 'values', 'office', 'headquarters', 'hq', 'location',
  'locations', 'services', 'solutions', 'team', 'staff', 'careers', 'career',
  'jobs', 'news', 'blog', 'events', 'gallery', 'portfolio', 'projects',
  'testimonials', 'reviews', 'pricing', 'plans', 'features', 'resources',
  'downloads', 'partners', 'clients', 'customers', 'company',
  // CTA / verbs / adverbs
  'view', 'learn', 'read', 'click', 'here', 'more', 'today', 'now', 'get',
  'started', 'find', 'out', 'discover', 'explore', 'see', 'browse', 'apply',
  'join', 'book', 'call', 'email', 'send', 'submit', 'download', 'sign', 'up',
  'in', 'next', 'previous', 'back', 'close', 'open', 'accept', 'decline',
  'manage', 'continue', 'load', 'show', 'hide',
]);

function looksLikePersonName(name) {
  let t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 4 || t.length > 60) return false;
  // Sentence punctuation rules it out (but "." for initials/honorifics is fine).
  if (/[?!,:;@/\\|()<>{}\[\]]/.test(t)) return false;
  if (/\d/.test(t)) return false;                          // digits = not a name
  let words = t.split(' ').filter(Boolean);
  if (words.length && HONORIFIC_RE.test(words[0])) words = words.slice(1);
  if (words.length < 2 || words.length > 5) return false;  // "Jane Doe" .. up to 5 parts
  // Any web-chrome / heading word means it's not a person.
  if (words.some(w => NON_NAME_TOKENS.has(w.toLowerCase().replace(/[.'’\-]+$/, '')))) {
    return false;
  }
  const NAME_WORD = /^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]*$/;          // Title-cased, incl. O'Brien, Anne-Marie
  const INITIAL = /^[A-ZÀ-Ý]\.?$/;                          // "J" or "J."
  const PARTICLE = /^(van|von|de|del|della|di|da|du|la|le|el|al|bin|ibn|st|mc|mac)$/i;
  const nameLike = words.filter(w => NAME_WORD.test(w) || INITIAL.test(w) || PARTICLE.test(w)).length;
  if (nameLike / words.length < 0.7) return false;
  // Need at least two genuinely capitalised parts (first + last).
  const caps = words.filter(w => /^[A-ZÀ-Ý]/.test(w)).length;
  return caps >= 2;
}

// A company obviously isn't its own employee — but "HALO Labs" (all-caps
// first word) passes looksLikePersonName's title-case check same as "Halo
// Watson" would, since it only requires two capitalised word-like tokens.
// Comparing directly against the company name being scanned catches this
// without weakening the general name-shape heuristic for everyone else.
function normalizeForCompanyCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(labs?|inc|llc|ltd|pty|co|corp|corporation|group|studio|studios|agency|solutions|technologies|technology|tech|services|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeCompanyNameItself(name, companyName) {
  if (!companyName) return false;
  const a = normalizeForCompanyCompare(name);
  const b = normalizeForCompanyCompare(companyName);
  if (!a || !b) return false;
  return a === b;
}

function isValidTeamMember(member, companyName) {
  if (!member?.name) return false;
  const name = String(member.name).trim();
  if (name.length < 4) return false;
  if (looksLikeCompanyNameItself(name, companyName)) return false;
  if (looksLikeConsentBanner(member)) return false;
  if (!looksLikePersonName(name)) return false;
  if (isPlaceName(name)) return false;
  if (isServiceName(name)) return false;
  if (looksLikeOfferingHeading(name)) return false;
  if (looksLikeServiceBio(member.bio)) return false;
  if (looksLikeServiceTitle(member.title)) return false;
  if (looksLikeServiceMenu(member.title)) return false;
  if (looksLikeAddress(member.bio)) return false;
  if (looksLikeAddress(member.title)) return false;
  // Name is mostly the address repeated
  if (member.bio && name.length > 6) {
    const bioStart = String(member.bio).slice(0, name.length + 5).toLowerCase();
    if (bioStart.includes(name.toLowerCase()) && looksLikeAddress(member.bio)) return false;
  }
  return true;
}

function filterValidTeam(team) {
  return (team || []).filter(isValidTeamMember);
}

module.exports = {
  isPlaceName,
  isSectionHeading,
  looksLikeOfferingHeading,
  isServiceName,
  looksLikeServiceBio,
  looksLikeServiceTitle,
  looksLikeServiceMenu,
  looksLikeAddress,
  looksLikeConsentBanner,
  looksLikePersonName,
  isValidTeamMember,
  filterValidTeam,
};
