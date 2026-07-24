// Generates a cover letter personalised to one company: AI-written (when
// ANTHROPIC_API_KEY is set) referencing that company's own scraped description
// so it actually engages with their business instead of reading as generic
// filler, with a template fallback when there's no key.

const llm = require('./llmClient');
const { accentFor, escapeHtml } = require('./documentBrand');
const { htmlToPdfBuffer } = require('./resumeService');

function today() {
  return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function candidateHighlights(profile) {
  const bits = [];
  if (profile.currentRole) bits.push(profile.currentRole);
  if (profile.experienceYears) bits.push(`${profile.experienceYears} years' experience`);
  if ((profile.skills || []).length) bits.push((profile.skills || []).slice(0, 4).join(', '));
  return bits.join(' · ');
}

// Scraped "About" text often carries a crawler label ("TL;DR:", "About
// us:") worth stripping. Beyond that, don't try to grammatically splice the
// rest into a continuation sentence — descriptions start with the company
// name ("Acme makes..."), a pronoun ("We help..."), or neither, and
// guessing wrong reads broken either way (the caller quotes this verbatim
// as its own clause instead, which works regardless).
function cleanBlurb(blurb) {
  return blurb.replace(/^\s*(tl;?dr|about( us)?|our story|who we are)\s*:\s*/i, '').trim();
}

function templateLetter(profile, company) {
  const name = profile.name || 'Applicant';
  const companyName = company.name || 'your company';
  const cleaned = cleanBlurb((company.description || '').trim());
  const blurbSentence = cleaned.split(/(?<=[.!?])\s+/)[0]?.trim().replace(/[.!]$/, '') || '';
  const skill = (profile.skills || [])[0] || (company.opportunities || [])[0] || 'this role';
  const highlight = profile.experienceSummary || profile.summary || profile.pitch || '';

  const paragraphs = [
    `I'm writing to express my interest in opportunities at ${companyName}.`,
    blurbSentence
      ? `From what I've read on your site, this stood out: "${blurbSentence}" — that's exactly the kind of work I want to contribute to.`
      : `I've been following ${companyName}'s work and would welcome the chance to contribute.`,
    highlight
      ? `${highlight} I bring hands-on experience in ${skill}${profile.currentRole ? ` most recently as ${profile.currentRole}` : ''}, and I'm confident I could add value from day one.`
      : `I bring hands-on experience in ${skill}, and I'm confident I could add value from day one.`,
    `I'd welcome the opportunity to discuss how I can support ${companyName}'s goals. Thank you for your time and consideration.`,
  ];
  return { paragraphs, source: 'template' };
}

async function aiLetter(profile, company) {
  if (!llm.hasKey()) return null;

  const system = `You write concise, honest professional cover letters (not cold-outreach emails).
Return ONLY valid JSON: { "paragraphs": ["...", "...", "..."] } — 3 to 4 short paragraphs, no headers/greeting/signoff (those are added separately), no hype, no fabricated claims, Australian English OK.`;

  const user = `Write a cover letter for ${profile.name || 'the candidate'} applying to "${company.name}" (${company.type || 'a local business'}).
Company description (from their own website, reference something specific from it if relevant): ${(company.description || 'unknown').slice(0, 600)}
Candidate summary: ${profile.summary || profile.experienceSummary || profile.pitch || 'none provided'}
Candidate current/most recent role: ${profile.currentRole || 'none provided'}
Candidate skills: ${(profile.skills || []).join(', ') || 'none provided'}
Candidate experience: ${profile.experienceYears || 'unspecified'} years
Tie the candidate's actual background to what this specific company appears to need or value.`;

  try {
    const parsed = await llm.completeJson({ system, user, maxTokens: 1200 });
    const paragraphs = ((parsed && parsed.paragraphs) || []).map(String).filter(p => p.trim().length > 20);
    if (paragraphs.length >= 2) return { paragraphs, source: 'claude' };
  } catch (err) {
    console.warn('[cover-letter-ai]', err.message);
  }
  return null;
}

async function generateCoverLetterContent(profile, company) {
  const ai = await aiLetter(profile, company);
  return ai || templateLetter(profile, company);
}

function renderCoverLetterHtml(profile, company, letter) {
  const accent = accentFor(profile);
  const p = profile;
  const contactLines = [p.email || p.senderEmail, p.phone, p.city].filter(Boolean).map(escapeHtml);
  const greetingName = 'Hiring Team';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #1c1c1c;
    font-size: 12px; line-height: 1.7; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { padding: 52px 56px; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid ${accent.strong}; padding-bottom: 16px; margin-bottom: 28px; }
  .name { font-size: 22px; font-weight: 700; color: #111; letter-spacing: -0.3px; }
  .contact { text-align: right; font-size: 10.5px; color: #444; line-height: 1.6; }
  .date { font-size: 11px; color: #666; margin-bottom: 18px; }
  .to { font-size: 12px; color: #222; margin-bottom: 20px; }
  .to strong { display: block; font-size: 13px; }
  p { margin: 0 0 14px; }
  .signoff { margin-top: 10px; }
  .signoff .sig-name { font-weight: 700; margin-top: 26px; }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="name">${escapeHtml(p.name || 'Your name')}</div>
      <div class="contact">${contactLines.join('<br>')}</div>
    </div>
    <div class="date">${today()}</div>
    <div class="to"><strong>${escapeHtml(company.name || 'Hiring Team')}</strong>${company.address ? escapeHtml(company.address) : ''}</div>
    <p>Dear ${escapeHtml(greetingName)},</p>
    ${letter.paragraphs.map(para => `<p>${escapeHtml(para)}</p>`).join('')}
    <div class="signoff">
      <div>Sincerely,</div>
      <div class="sig-name">${escapeHtml(p.name || '')}</div>
    </div>
  </div>
</body>
</html>`;
}

async function renderCoverLetterPdf(profile, company) {
  const letter = await generateCoverLetterContent(profile, company);
  const html = renderCoverLetterHtml(profile, company, letter);
  return htmlToPdfBuffer(html);
}

module.exports = { generateCoverLetterContent, renderCoverLetterHtml, renderCoverLetterPdf };
