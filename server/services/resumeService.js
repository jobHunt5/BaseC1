// Renders a user's profile into a designed, single-file HTML resume and
// prints it to PDF via headless Chrome (puppeteer) — no template library,
// no build step, consistent with the rest of this project.

const { accentFor, escapeHtml } = require('./documentBrand');

function section(title, innerHtml) {
  if (!innerHtml) return '';
  return `<div class="section"><div class="section-title">${escapeHtml(title)}</div>${innerHtml}</div>`;
}

function dateRange(w) {
  const start = w.startDate || '';
  const end = w.current ? 'Present' : (w.endDate || '');
  if (!start && !end) return '';
  return [start, end].filter(Boolean).join(' — ');
}

function workEntryHtml(w) {
  const range = dateRange(w);
  return `
    <div class="entry">
      <div class="entry-head">
        <div>
          <div class="entry-title">${escapeHtml(w.title || 'Role')}</div>
          <div class="entry-sub">${escapeHtml(w.company || '')}${w.location ? ` · ${escapeHtml(w.location)}` : ''}</div>
        </div>
        ${range ? `<div class="entry-date">${escapeHtml(range)}</div>` : ''}
      </div>
      ${w.description ? `<div class="entry-desc">${escapeHtml(w.description)}</div>` : ''}
    </div>`;
}

function projectEntryHtml(p) {
  return `
    <div class="entry proj-entry">
      <div class="entry-head">
        <div class="entry-title">${escapeHtml(p.name || 'Project')}</div>
        ${p.url ? `<div class="entry-date">${escapeHtml(p.url)}</div>` : ''}
      </div>
      ${p.tech ? `<div class="entry-sub">${escapeHtml(p.tech)}</div>` : ''}
      ${p.description ? `<div class="entry-desc">${escapeHtml(p.description)}</div>` : ''}
    </div>`;
}

function eduEntryHtml(e) {
  const line2 = [e.institution, e.year].filter(Boolean).map(escapeHtml).join(' · ');
  return `
    <div class="edu-entry">
      <div class="entry-title">${escapeHtml(e.degree || '')}${e.field ? ` — ${escapeHtml(e.field)}` : ''}</div>
      ${line2 ? `<div class="entry-sub">${line2}</div>` : ''}
    </div>`;
}

function certEntryHtml(c) {
  const line2 = [c.issuer, c.year].filter(Boolean).map(escapeHtml).join(' · ');
  return `
    <div class="cert-entry">
      <div class="entry-title">${escapeHtml(c.name || '')}</div>
      ${line2 ? `<div class="entry-sub">${line2}</div>` : ''}
    </div>`;
}

function langEntryHtml(l) {
  return `<div class="lang-entry"><span class="entry-title">${escapeHtml(l.name || '')}</span>${l.level ? `<span class="entry-sub"> — ${escapeHtml(l.level)}</span>` : ''}</div>`;
}

function renderResumeHtml(profile = {}) {
  const accent = accentFor(profile);
  const p = profile;

  const contactLines = [
    p.email || p.senderEmail,
    p.phone,
    p.city,
    p.links?.website,
    p.links?.linkedin,
    p.links?.github,
  ].filter(Boolean).map(escapeHtml);

  const headline = p.currentRole || (p.jobSectors || [])[0] || '';

  const skillsHtml = (p.skills || []).length
    ? `<div class="skills-row">${(p.skills || []).map(s => `<span class="skill-pill">${escapeHtml(s)}</span>`).join('')}</div>`
    : '';

  const workHtml = (p.workHistory || []).length
    ? (p.workHistory || []).map(workEntryHtml).join('')
    : (p.currentRole || p.experienceSummary
      ? workEntryHtml({ title: p.currentRole, description: p.experienceSummary, endDate: '', current: true })
      : '');

  const projectsHtml = (p.projects || []).map(projectEntryHtml).join('');
  const eduHtml = (p.education || []).map(eduEntryHtml).join('');
  const certHtml = (p.certifications || []).map(certEntryHtml).join('');
  const langHtml = (p.languages || []).map(langEntryHtml).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #1c1c1c;
    font-size: 11px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { padding: 42px 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid ${accent.strong}; padding-bottom: 16px; margin-bottom: 20px; }
  .name { font-size: 27px; font-weight: 700; color: #111; letter-spacing: -0.4px; }
  .headline { font-size: 12.5px; color: ${accent.strong}; font-weight: 600; margin-top: 4px; }
  .contact { text-align: right; font-size: 10px; color: #444; line-height: 1.7; max-width: 220px; }
  .section { margin-bottom: 16px; }
  .section-title { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: ${accent.strong}; margin-bottom: 8px; border-bottom: 1px solid #e4e4e4; padding-bottom: 4px; }
  .summary-text { font-size: 11.5px; color: #333; }
  .skills-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .skill-pill { background: ${accent.mid}; border-radius: 12px; padding: 3px 11px; font-size: 10.5px; color: #222; }
  .entry { margin-bottom: 11px; }
  .entry:last-child { margin-bottom: 0; }
  .entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .entry-title { font-weight: 700; font-size: 12px; color: #111; }
  .entry-sub { font-size: 10.5px; color: #555; margin-top: 1px; }
  .entry-date { font-size: 10px; color: #888; white-space: nowrap; flex-shrink: 0; }
  .entry-desc { font-size: 11px; color: #333; margin-top: 4px; white-space: pre-line; }
  .two-col { display: flex; gap: 30px; }
  .two-col .col { flex: 1; min-width: 0; }
  .edu-entry, .cert-entry { margin-bottom: 9px; }
  .lang-entry { margin-bottom: 5px; font-size: 11px; }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="name">${escapeHtml(p.name || 'Your name')}</div>
        ${headline ? `<div class="headline">${escapeHtml(headline)}</div>` : ''}
      </div>
      <div class="contact">${contactLines.join('<br>')}</div>
    </div>
    ${section('Summary', p.summary ? `<div class="summary-text">${escapeHtml(p.summary)}</div>` : (p.pitch ? `<div class="summary-text">${escapeHtml(p.pitch)}</div>` : ''))}
    ${section('Skills', skillsHtml)}
    ${section('Experience', workHtml)}
    ${section('Projects', projectsHtml)}
    <div class="two-col">
      <div class="col">${section('Education', eduHtml)}</div>
      <div class="col">
        ${section('Certifications', certHtml)}
        ${section('Languages', langHtml)}
      </div>
    </div>
  </div>
</body>
</html>`;
}

let _browserPromise = null;
function getBrowser() {
  if (!_browserPromise) {
    const puppeteer = require('puppeteer');
    _browserPromise = puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    _browserPromise.catch(() => { _browserPromise = null; });
  }
  return _browserPromise;
}

// A freshly-launched Chromium's first page can take longer to settle than
// the default 30s navigation timeout (renderer process still spinning up) —
// warm it once at server boot so the first real PDF request never eats that
// cold-start cost. Safe to call multiple times; getBrowser() caches the launch.
async function warmup() {
  try {
    await htmlToPdfBuffer('<!doctype html><html><body>warmup</body></html>', { timeoutMs: 60000 });
  } catch (err) {
    console.warn('[resume] PDF engine warmup failed (will retry on first real request):', err.message);
  }
}

async function htmlToPdfBuffer(html, { timeoutMs = 30000 } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await page.close();
  }
}

async function renderResumePdf(profile) {
  return htmlToPdfBuffer(renderResumeHtml(profile));
}

module.exports = { renderResumeHtml, renderResumePdf, htmlToPdfBuffer, warmup, section, escapeHtml };
