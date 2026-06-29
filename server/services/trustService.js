// Shared trust / validation helpers — every enriched field should pass through here.

const CAREER_PREFIXES = ['careers', 'jobs', 'hr', 'talent', 'recruiting', 'recruitment', 'people', 'hiring'];

const BLOCKED_EMAIL_RE = [
  /^noreply@/i, /^no[-_.]?reply@/i, /^donotreply@/i, /^mailer-daemon@/i,
  /^postmaster@/i, /^webmaster@/i, /^admin@/i, /^root@/i,
  /^(user|test|demo|example|sample|yourname|you|myaddress)@/i,
  /@(example\.com|domain\.com|email\.com|world\.com|mysite\.com|yoursite\.com|yourcompany\.com|yourdomain\.com|sentry\.io|wixpress\.com|squarespace\.com|hubspot\.com|mailchimp\.com|sendgrid\.net|amazonses\.com)$/i,
  /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i,
  /^[a-f0-9]{16,}@/i,
  /@2x\.|@3x\./i,
  /popperjs|tippy@|lottie@|\.min\.js@/i,
];

const HIGH_CONFIDENCE_JOB_SOURCES = new Set(['greenhouse', 'lever', 'workable', 'ashby', 'json-ld', 'jobadder']);
const BOARD_JOB_SOURCES = new Set(['seek', 'indeed', 'linkedin-jobs', 'jora']);
const VERIFIED_LINKEDIN_MEMBER_SOURCES = new Set(['website', 'linkedin_company', 'serper']);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isBlockedEmail(email) {
  if (!email || email.length > 80) return true;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return true;
  return BLOCKED_EMAIL_RE.some(re => re.test(email));
}

function isPlausibleEmail(email) {
  return !isBlockedEmail(email);
}

/**
 * Pick the most trustworthy contact email from a crawl.
 * Returns { email, email_source, email_verified } — never guesses off-domain as verified.
 */
function pickTrustedEmail(emails, homeUrl) {
  const clean = (emails || []).map(e => String(e).toLowerCase().trim()).filter(isPlausibleEmail);
  if (!clean.length) return { email: null, email_source: null, email_verified: false };

  const host = hostOf(homeUrl);
  const sameDomain = host ? clean.filter(e => e.endsWith('@' + host)) : [];

  // Tier 1: careers@ / jobs@ on company domain
  for (const prefix of CAREER_PREFIXES) {
    const hit = sameDomain.find(e => {
      const local = e.split('@')[0];
      return local === prefix || local.startsWith(prefix);
    });
    if (hit) return { email: hit, email_source: 'careers_prefix', email_verified: true };
  }

  // Tier 2: hello@ / contact@ / info@ on company domain (common real inboxes)
  for (const prefix of ['hello', 'contact', 'info', 'enquiries', 'inquiries', 'studio', 'team']) {
    const hit = sameDomain.find(e => e.startsWith(prefix + '@'));
    if (hit) return { email: hit, email_source: 'contact_page', email_verified: true };
  }

  // Tier 3: any other same-domain address (verified domain match)
  if (sameDomain.length) {
    return { email: sameDomain[0], email_source: 'website_domain', email_verified: true };
  }

  // Tier 4: off-domain — show but never mark verified (often vendor/form noise)
  return { email: clean[0], email_source: 'off_domain', email_verified: false };
}

/** Does an ATS board slug plausibly belong to this company? */
function atsSlugMatchesCompany(slug, company) {
  if (!slug || !company) return false;
  const s = slug.toLowerCase();
  const name = (company.name || '').toLowerCase();
  const words = name.split(/[\s\-&]+/).filter(w => w.length > 3);
  if (words.some(w => s.includes(w))) return true;
  const host = hostOf(company.website);
  if (host) {
    const base = host.split('.')[0];
    if (base.length > 3 && (s.includes(base) || base.includes(s.replace(/-/g, '')))) return true;
  }
  return false;
}

function jobConfidence(source) {
  if (HIGH_CONFIDENCE_JOB_SOURCES.has(source)) return 'verified';
  if (BOARD_JOB_SOURCES.has(source)) return 'board';
  if (source === 'careers-page') return 'found';
  return 'unknown';
}

function isHighConfidenceJob(source) {
  return HIGH_CONFIDENCE_JOB_SOURCES.has(source);
}

function linkedinMemberConfidence(member) {
  if (!member?.linkedin_url) return 'none';
  if (VERIFIED_LINKEDIN_MEMBER_SOURCES.has(member.linkedin_source)) return 'verified';
  return 'none';
}

function extractLinkedInCompanyUrl(socials) {
  const url = socials?.linkedin || '';
  if (!url || !/linkedin\.com\/company\//i.test(url)) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

function buildCompanyLinkedIn(company) {
  const url = extractLinkedInCompanyUrl(company.socials || {});
  const { linkedinCompanyPeopleUrl } = require('./linkedinService');
  const peopleUrl = url ? linkedinCompanyPeopleUrl(url) : null;

  if (url) {
    return {
      status: 'verified',
      status_label: 'Verified company page',
      message: 'LinkedIn company page found on their website',
      company_url: url,
      people_url: peopleUrl,
      verified: true,
    };
  }

  return {
    status: 'none',
    status_label: 'No verified LinkedIn found',
    message: 'No verified LinkedIn company page found on their website',
    company_url: null,
    people_url: null,
    verified: false,
  };
}

function buildCompanyLinks(company) {
  const socials = company.socials || {};
  const out = [];

  if (company.website) {
    out.push({ kind: 'website', label: 'Website', url: company.website, verified: true });
  }
  if (company.careers_url) {
    out.push({ kind: 'careers', label: 'Careers', url: company.careers_url, verified: true });
  }

  const li = extractLinkedInCompanyUrl(socials);
  if (li) {
    out.push({ kind: 'linkedin_company', label: 'LinkedIn (company)', url: li, verified: true });
  }

  const SOCIAL_LABELS = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    twitter: 'X / Twitter',
    youtube: 'YouTube',
    tiktok: 'TikTok',
  };
  for (const [key, label] of Object.entries(SOCIAL_LABELS)) {
    if (socials[key]) {
      out.push({ kind: key, label, url: socials[key], verified: true });
    }
  }

  return out;
}

function buildTrustSummary(company, jobs, team, linkedin) {
  const verifiedJobs = (jobs || []).filter(j =>
    j.confidence === 'verified' || isHighConfidenceJob(j.source),
  ).length;
  const websiteJobs = (jobs || []).filter(j => !BOARD_JOB_SOURCES.has(j.source)).length;
  const verifiedTeam = (team || []).filter(m =>
    m.linkedin_verified || linkedinMemberConfidence(m) === 'verified',
  ).length;

  const parts = [];
  if (company.email_verified && company.email) parts.push('verified contact email');
  if (linkedin?.verified) parts.push('verified LinkedIn company page');
  if (verifiedJobs) parts.push(`${verifiedJobs} verified job listing${verifiedJobs !== 1 ? 's' : ''}`);
  else if (websiteJobs) parts.push(`${websiteJobs} role${websiteJobs !== 1 ? 's' : ''} from careers page`);
  if (verifiedTeam) parts.push(`${verifiedTeam} verified team LinkedIn profile${verifiedTeam !== 1 ? 's' : ''}`);

  return {
    level: verifiedJobs || linkedin?.verified || (company.email_verified && company.email)
      ? 'high'
      : (websiteJobs || company.enriched_at ? 'medium' : 'low'),
    summary: parts.length
      ? parts.join(' · ')
      : 'Limited data — run a full scan to verify jobs and contacts',
    verified_jobs: verifiedJobs,
    website_jobs: websiteJobs,
    verified_team_linkedin: verifiedTeam,
    linkedin_company_verified: !!linkedin?.verified,
  };
}

// --- description trust ---------------------------------------------------
// Reject nav menus, "Skip to content", and WP theme chrome scraped as copy.

const NAV_JUNK_RE = [
  /skip to content/i,
  /\bhome\b.*\babout\s*us\b.*\bservices\b/i,
  /\b(contact\s*us|portfolio)\b.*\b(home|services|about)\b/i,
  /\b(privacy\s*policy|terms\s*(of|&)\s*conditions|sitemap)\b/i,
];

const NAV_PHRASES = [
  'home', 'about us', 'services', 'contact us', 'portfolio', 'blog',
  'privacy policy', 'terms and conditions', 'skip to content', 'menu',
];

const PLACEHOLDER_RE = [
  /lorem ipsum/i,
  /dolor sit amet/i,
  /consectetur adipiscing/i,
  /your company (name|here)/i,
  /sample text/i,
  /\bplaceholder\b/i,
  /\[insert\s/i,
  /click here to edit/i,
  /this is a (sample|demo|placeholder)/i,
  /cutting-edge IT solutions tailored to meet the unique needs of modern businesses/i,
  /digital transformation, enhanced operational efficiency/i,
];

/** True when text looks like a nav menu or theme chrome, not a company blurb. */
function isJunkDescription(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 30) return true;
  if (PLACEHOLDER_RE.some(re => re.test(t))) return true;
  if (NAV_JUNK_RE.some(re => re.test(t))) return true;

  const lower = t.toLowerCase();
  const navHits = NAV_PHRASES.filter(p => lower.includes(p)).length;
  if (navHits >= 3) return true;

  // WordPress / Elementor sites: "Logo Package Website Package …"
  const packageHits = (t.match(/\b\w+\s+package(s)?\b/gi) || []).length;
  if (packageHits >= 2) return true;

  const words = t.split(/\s+/);
  if (words.length >= 10) {
    const titleCase = words.filter(w => /^[A-Z][a-z]{1,18}$/.test(w)).length;
    // Long run of menu labels with no sentence punctuation in the first chunk
    if (titleCase / words.length > 0.45 && !/[.!?]/.test(t.slice(0, Math.min(t.length, 160)))) {
      return true;
    }
  }

  return false;
}

/** Return cleaned description or empty string — never show nav junk. */
function sanitizeDescription(text, companyName) {
  if (!text || isJunkDescription(text)) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Rank candidate blurbs — prefer ones that mention the company name. */
function scoreDescription(text, companyName) {
  if (!text || isJunkDescription(text)) return -1;
  let score = Math.min(text.length, 200);
  const words = (companyName || '').toLowerCase().split(/[\s\-&]+/).filter(w => w.length > 3);
  const lower = text.toLowerCase();
  for (const w of words) {
    if (lower.includes(w)) score += 100;
  }
  if (/[.!?]/.test(text)) score += 15;
  return score;
}

function pickBestDescription(candidates, companyName) {
  let best = '';
  let bestScore = -1;
  for (const raw of candidates || []) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const score = scoreDescription(text, companyName);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return sanitizeDescription(best, companyName);
}

module.exports = {
  isBlockedEmail,
  isPlausibleEmail,
  pickTrustedEmail,
  atsSlugMatchesCompany,
  jobConfidence,
  isHighConfidenceJob,
  linkedinMemberConfidence,
  buildCompanyLinkedIn,
  buildCompanyLinks,
  buildTrustSummary,
  isJunkDescription,
  sanitizeDescription,
  scoreDescription,
  pickBestDescription,
  CAREER_PREFIXES,
  HIGH_CONFIDENCE_JOB_SOURCES,
  BOARD_JOB_SOURCES,
};
