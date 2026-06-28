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

function isValidTeamMember(member) {
  if (!member?.name) return false;
  const name = String(member.name).trim();
  if (name.length < 4) return false;
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
  isValidTeamMember,
  filterValidTeam,
};
