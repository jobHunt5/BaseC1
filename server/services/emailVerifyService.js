// Deep email verification before outreach: re-check website + DNS MX records.

const dns = require('dns').promises;
const axios = require('axios');
const { isPlausibleEmail, pickTrustedEmail } = require('./trustService');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const TIMEOUT = parseInt(process.env.ENRICH_TIMEOUT_MS || '8000', 10);
const UA = process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0';

const CRAWL_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us'];

function normalizeUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '') || null;
}

function absolutize(path, base) {
  try {
    return new URL(path, base).href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  try {
    const resp = await axios.get(url, {
      timeout: TIMEOUT,
      maxRedirects: 4,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      validateStatus: s => s >= 200 && s < 400,
    });
    return String(resp.data || '');
  } catch {
    return '';
  }
}

function emailOnPage(html, email) {
  if (!html || !email) return false;
  const e = String(email).toLowerCase();
  const local = e.split('@')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:mailto:)?${local}@[a-z0-9.-]+`, 'i');
  return re.test(html) || html.toLowerCase().includes(e);
}

async function checkMx(domain) {
  if (!domain) return { ok: false, records: [] };
  try {
    const records = await dns.resolveMx(domain);
    const sorted = (records || []).sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return { ok: sorted.length > 0, records: sorted.map(r => r.exchange) };
  } catch {
    return { ok: false, records: [] };
  }
}

function domainOf(email) {
  const m = String(email || '').toLowerCase().match(/@([^@]+)$/);
  return m ? m[1].replace(/^www\./, '') : '';
}

/**
 * Verify a company's contact email before sending.
 * Passes when: same-domain match + found on website OR mailto + MX records exist.
 */
async function verifyCompanyEmail(company) {
  const result = {
    verified: false,
    email: company.email || null,
    checks: {
      has_email: false,
      domain_match: false,
      on_website: false,
      mx_records: false,
    },
    message: '',
  };

  const pool = [...new Set([company.email, ...(company.all_emails || [])].filter(Boolean))]
    .map(e => String(e).toLowerCase().trim())
    .filter(isPlausibleEmail);

  if (!pool.length) {
    result.message = 'No email found for this company — enrich their website first.';
    return result;
  }

  const homeUrl = normalizeUrl(company.website);
  const picked = pickTrustedEmail(pool, homeUrl || '');
  const candidate = picked.email || pool[0];
  result.email = candidate;
  result.checks.has_email = true;

  const siteHost = hostOf(homeUrl);
  const emailHost = domainOf(candidate);
  result.checks.domain_match = !!(siteHost && emailHost && (
    emailHost === siteHost || emailHost.endsWith('.' + siteHost) || siteHost.endsWith('.' + emailHost)
  ));

  if (homeUrl) {
    const urls = [...new Set(CRAWL_PATHS.map(p => absolutize(p, homeUrl)).filter(Boolean))];
    const pages = await Promise.all(urls.map(fetchPage));
    result.checks.on_website = pages.some(html => emailOnPage(html, candidate));
  }

  const mx = await checkMx(emailHost);
  result.checks.mx_records = mx.ok;

  const verified = result.checks.on_website && result.checks.mx_records && (
    result.checks.domain_match || picked.email_verified
  );

  result.verified = verified;
  result.email_source = picked.email_source || (result.checks.domain_match ? 'website_domain' : 'off_domain');

  if (verified) {
    result.message = 'Email verified — found on their website with valid MX records.';
  } else if (!result.checks.on_website) {
    result.message = 'Could not confirm this address on their website. Check their contact page manually.';
  } else if (!result.checks.mx_records) {
    result.message = 'Domain has no MX records — this address may not receive mail.';
  } else if (!result.checks.domain_match) {
    result.message = 'Email domain does not match their website — not verified for direct send.';
  } else {
    result.message = 'Verification incomplete — try again after enrichment finishes.';
  }

  return result;
}

module.exports = { verifyCompanyEmail, checkMx, emailOnPage };
