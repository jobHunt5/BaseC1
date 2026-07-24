// AI + template outreach drafts — multiple creative options per company.

const llm = require('./llmClient');

const TONES = [
  { id: 'warm', label: 'Warm intro', hint: 'Friendly, conversational' },
  { id: 'direct', label: 'Direct pitch', hint: 'Short and to the point' },
  { id: 'creative', label: 'Creative hook', hint: 'Memorable opening line' },
  { id: 'value', label: 'Value-first', hint: 'Lead with what you can offer' },
];

function buildContext(company, profile = {}) {
  return {
    companyName: company.name || 'the business',
    companyType: company.type || '',
    address: company.address || '',
    website: company.website || '',
    description: (company.description || '').slice(0, 600),
    opportunities: (company.opportunities || []).slice(0, 4),
    userName: profile.name || '',
    userSkills: (profile.skills || []).join(', '),
    userCity: profile.city || '',
    userPitch: profile.pitch || '',
    userPortfolio: profile.portfolio || profile.portfolioUrl || '',
  };
}

function templateVariant(tone, ctx) {
  const name = ctx.userName || '[Your name]';
  const skill = (profileSkill(ctx) || 'design').toLowerCase();
  const company = ctx.companyName;
  const obs = observationFor(ctx);
  const portfolio = ctx.userPortfolio ? `\nPortfolio: ${ctx.userPortfolio}` : '';

  const subjects = {
    warm: `${capitalize(skill)} help for ${company}`,
    direct: `Quick question — ${skill} for ${company}`,
    creative: `Idea for ${company}'s ${skill === 'design' ? 'brand' : 'online presence'}`,
    value: `Could save ${company} time on ${skill}`,
  };

  const bodies = {
    warm: [
      `Hi ${company} team,`,
      '',
      ctx.userPitch || `I'm ${name}, a ${skill}${ctx.userCity ? ` based in ${ctx.userCity}` : ''}.`,
      '',
      `I came across ${company}${ctx.address ? ` (${shortAddr(ctx.address)})` : ''} and ${obs}`,
      '',
      `If ${skill} is on your radar, I'd love a quick chat — even 15 minutes would be useful.`,
      portfolio,
      '',
      'Best,',
      name,
    ].join('\n'),
    direct: [
      `Hi ${company} team,`,
      '',
      `${name} here — I specialise in ${skill}${ctx.userSkills ? ` (${ctx.userSkills})` : ''}.`,
      '',
      `${obs.charAt(0).toUpperCase()}${obs.slice(1)}`,
      '',
      `Open to a brief call this week if you're exploring ${skill} support?`,
      portfolio,
      '',
      name,
    ].join('\n'),
    creative: [
      `Hi ${company} team,`,
      '',
      `I'll keep this short — your ${ctx.companyType || 'business'} stood out${ctx.address ? ` on ${shortAddr(ctx.address)}` : ''}, and I had a specific thought about your ${skill} presence.`,
      '',
      obs,
      '',
      `I'm ${name}. Happy to share a few concrete ideas if useful — no pitch deck, just an honest second pair of eyes.`,
      portfolio,
      '',
      'Cheers,',
      name,
    ].join('\n'),
    value: [
      `Hi ${company} team,`,
      '',
      `I'm ${name}. I help local businesses with ${skill} — usually things like sharper product shots, cleaner web UX, or brand refreshes that actually convert.`,
      '',
      `Looking at ${company}, ${obs}`,
      '',
      `If that's relevant, I can send 2–3 quick wins I'd tackle first — no obligation.`,
      portfolio,
      '',
      'Best,',
      name,
    ].join('\n'),
  };

  const toneMeta = TONES.find(t => t.id === tone) || TONES[0];
  return {
    tone: toneMeta.id,
    label: toneMeta.label,
    hint: toneMeta.hint,
    subject: subjects[tone] || subjects.warm,
    body: bodies[tone] || bodies.warm,
    source: 'template',
  };
}

function profileSkill(ctx) {
  if (ctx.userSkills) return ctx.userSkills.split(',')[0].trim();
  if (ctx.opportunities?.length) return ctx.opportunities[0];
  return 'design';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function shortAddr(a) {
  return String(a).split(',').slice(0, 2).join(',').trim();
}

// Prefers a real line from the company's own scraped description (their
// actual mission/offering, in their own words) over a generic keyword-
// matched guess — makes the template fallback feel researched even without
// an OpenAI key.
function observationFor(ctx) {
  // Scraped "About" text often carries a crawler label ("TL;DR:", "About
  // us:") worth stripping, but trying to grammatically splice the rest into
  // a continuation sentence is fragile — descriptions start with the company
  // name ("Acme makes..."), a pronoun ("We help..."), or neither, and
  // guessing wrong reads broken either way. Quoting the cleaned sentence
  // verbatim as its own clause sidesteps that entirely.
  const blurb = (ctx.description || '').trim()
    .replace(/^\s*(tl;?dr|about( us)?|our story|who we are)\s*:\s*/i, '').trim();
  if (blurb) {
    const firstSentence = blurb.split(/(?<=[.!?])\s+/)[0]?.trim().replace(/[.!]$/, '');
    if (firstSentence && firstSentence.length > 15 && firstSentence.length < 200) {
      return `they describe their own work as "${firstSentence}" — exactly the kind of thing I'd love to support.`;
    }
  }
  const hay = `${(ctx.companyName || '').toLowerCase()} ${(ctx.companyType || '').toLowerCase()}`;
  if (/store|shop|boutique|fashion|clothing|suit|warehouse|jewel/.test(hay)) {
    return 'strong product photography and a clean in-store / online experience often pay back fast for retailers like yours.';
  }
  if (/restaurant|cafe|food/.test(hay)) {
    return 'a lot of hospitality brands I work with refresh menus, signage and social content each season.';
  }
  if (/marketing|agency|creative/.test(hay)) {
    return 'studios like yours often benefit from tight portfolio presentation and clear service pages.';
  }
  return 'thought my skills might be useful as you grow.';
}

function templateVariants(company, profile) {
  const ctx = buildContext(company, profile);
  return TONES.map(t => templateVariant(t.id, ctx));
}

async function generateAiVariants(company, profile, { count = 4 } = {}) {
  const ctx = buildContext(company, profile);

  if (!llm.hasKey()) {
    return { variants: templateVariants(company, profile), ai: false };
  }

  const system = `You write short, honest cold outreach emails for freelancers pitching local businesses.
Return ONLY valid JSON: { "variants": [ { "tone": "warm|direct|creative|value", "label": "2-4 words", "subject": "...", "body": "..." } ] }
Rules: under 180 words each, no hype, no fake claims, Australian English OK, sign off with the sender's name.
Every email must reference something SPECIFIC from the company's own description (their actual mission, product,
or customers as they describe it) rather than a generic compliment — if no usable description is given, reference
their industry/type instead of inventing detail. Tie the sender's real skills/experience to what that specific
company appears to need, not a one-size-fits-all pitch.`;

  const user = `Generate ${count} different outreach emails to "${ctx.companyName}" (${ctx.companyType}).
Sender: ${ctx.userName || 'Freelancer'}, skills: ${ctx.userSkills || 'design/dev/marketing'}.
City: ${ctx.userCity || 'Melbourne'}. Pitch: ${ctx.userPitch || 'none'}.
Company's own description of themselves (their mission/offering, in their words — reference something concrete from this): ${ctx.description || 'unknown, use their industry instead'}.
Website: ${ctx.website || 'none'}.
Each variant must use a different tone and opening.`;

  try {
    const parsed = await llm.completeJson({ system, user, maxTokens: 2500 });
    const variants = ((parsed && parsed.variants) || []).slice(0, count).map(v => ({
      tone: v.tone || 'custom',
      label: v.label || v.tone || 'Draft',
      hint: 'AI generated',
      subject: String(v.subject || '').slice(0, 200),
      body: String(v.body || ''),
      source: 'claude',
    })).filter(v => v.body.length > 40);

    if (variants.length >= 2) {
      return { variants, ai: true };
    }
  } catch (err) {
    console.warn('[outreach-ai]', err.message);
  }

  return { variants: templateVariants(company, profile), ai: false, fallback: true };
}

module.exports = { generateAiVariants, templateVariants, TONES };
