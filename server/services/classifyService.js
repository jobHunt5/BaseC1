// Classify a business into one or more skill-category tags based on its name,
// declared "type", and any extra text we've scraped from the website.
// Categories match the front-end filter pills: design | dev | ai | marketing.

const KEYWORDS = {
  ai: [
    'ai', 'artificial intelligence', 'machine learning', 'deep learning',
    'neural network', 'llm', 'gpt', 'data science', 'data scientist',
    'nlp', 'computer vision', 'mlops', 'genai', 'gen ai',
  ],
  dev: [
    'software', 'developer', 'engineering', 'engineer',
    'saas', 'devops', 'backend', 'frontend',
    'full stack', 'fullstack', 'web agency', 'app studio',
    'mobile dev', 'react', 'node.js', 'fintech',
    'cybersecurity', 'blockchain', 'data engineering',
    'software house', 'tech company', 'tech studio',
  ],
  design: [
    'design studio', 'design agency', 'graphic design',
    'branding', 'brand agency', 'creative agency', 'creative studio',
    'ui/ux', 'ui & ux', 'product design', 'industrial design',
    'architecture studio', '3d studio', '3d animation', 'visualisation',
    'visualization', 'animation studio', 'motion design', 'illustration',
    'print studio', 'ux', 'ui',
  ],
  marketing: [
    'marketing', 'advertising', 'ad agency', 'pr agency', 'public relations',
    'media agency', 'seo', 'sem', 'social media', 'content agency',
    'growth agency', 'performance marketing', 'communications agency',
    'digital agency',
  ],
};

function makeMatcher(keywords) {
  return keywords.map((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordy = /^[a-z0-9]+$/i.test(w);
    return wordy
      ? new RegExp(`\\b${escaped}\\b`, 'i')
      : new RegExp(escaped, 'i');
  });
}

const MATCHERS = Object.fromEntries(
  Object.entries(KEYWORDS).map(([cat, words]) => [cat, makeMatcher(words)])
);

const SKILL_HINTS = {
  ai:        ['AI/ML', 'Python', 'Data'],
  dev:       ['Frontend', 'Backend', 'DevOps'],
  design:    ['UI/UX', 'Brand', 'Graphic Design'],
  marketing: ['SEO', 'Social', 'Content'],
};

const CAT_VISUAL = {
  ai:        { icon: '🤖', color: 'rgba(78,205,196,0.15)' },
  dev:       { icon: '⚙',  color: 'rgba(108,99,255,0.15)' },
  design:    { icon: '🎨', color: 'rgba(255,107,157,0.15)' },
  marketing: { icon: '📣', color: 'rgba(255,165,82,0.15)' },
  other:     { icon: '🏢', color: 'rgba(136,136,170,0.15)' },
};

const OPPORTUNITY_RULES = [
  { match: /restaurant|cafe|bakery|coffee|food|takeaway|pub|brewery|winery|deli|catering|patisserie|pizzeria|bistro|grill|bbq|hotpot|\bbar\b(?!rister)/i,
    opps: ['brand identity', 'menu design', 'photography', 'social media'] },
  { match: /hotel|motel|lodging|resort|hostel|bed.and.breakfast|airbnb/i,
    opps: ['web design', 'photography', 'social media', 'video'] },
  { match: /clothing|fashion|boutique|apparel|shoe|jewel(ery|ry)|accessor|cosmetic|perfume/i,
    opps: ['brand identity', 'ecommerce', 'photography', 'social media'] },
  { match: /\bstore\b|\bshop\b|vape|supermarket|grocery|market\b|department\s+store|gift|florist|pet\s+store|book\s+store/i,
    opps: ['ecommerce', 'web design', 'social media'] },
  { match: /clinic|doctor|dentist|dental|medical|physio|chiropract|optometr|psycholog|hospital/i,
    opps: ['web design', 'content', 'seo', 'brand identity'] },
  { match: /gym|fitness|yoga|pilates|crossfit|martial|sports/i,
    opps: ['brand identity', 'social media', 'video', 'web design'] },
  { match: /spa|salon|beauty|barber|hair|nail|massage|skin|aesthetic/i,
    opps: ['brand identity', 'social media', 'photography', 'web design'] },
  { match: /real\s*estate|propert(y|ies)|realtor|realty/i,
    opps: ['photography', 'video', 'web design', 'social media'] },
  { match: /law(yer)?|legal|attorney|barrister|solicitor|conveyanc/i,
    opps: ['web design', 'content', 'seo', 'brand identity'] },
  { match: /accountant|bookkeep|tax\s+agent|financial\s+plan|insurance|wealth/i,
    opps: ['web design', 'content', 'seo'] },
  { match: /architect|interior\s+design|landscap|build(er|ing)|construct/i,
    opps: ['web design', 'portfolio site', 'photography', 'video'] },
  { match: /school|college|university|tutor|educat|childcare|kindergarten|preschool/i,
    opps: ['web design', 'illustration', 'video', 'content'] },
  { match: /car|auto|motor|vehicle|garage|tyre|tire/i,
    opps: ['web design', 'photography', 'social media'] },
  { match: /plumb|electric|paint|clean|repair|handyman|landscap|gard(ener|ening)|roofing|pest/i,
    opps: ['web design', 'brand identity', 'seo'] },
  { match: /travel|tour|holiday|event|wedding|conference|venue|photographer|videographer/i,
    opps: ['web design', 'photography', 'social media', 'video'] },
  { match: /consult|advisor|coach|recruit|staff(ing)?/i,
    opps: ['web design', 'content', 'brand identity'] },
  { match: /gallery|museum|theatre|theater|art\s+studio|photo\s+studio|music\s+studio|artist|musician|band|film\s+production|video\s+production/i,
    opps: ['web design', 'brand identity', 'social media'] },
];

function dedupe(arr) {
  return Array.from(new Set(arr));
}

function classifySector(haystack) {
  const cats = [];
  for (const [cat, regexes] of Object.entries(MATCHERS)) {
    if (regexes.some((re) => re.test(haystack))) cats.push(cat);
  }
  return cats;
}

function buildClassifyResult(cats) {
  const primary = cats[0] || 'other';
  const visual = CAT_VISUAL[primary];
  const skills = [];
  for (const cat of cats) {
    if (SKILL_HINTS[cat]) skills.push(...SKILL_HINTS[cat]);
  }
  return {
    cats,
    skills: dedupe(skills).slice(0, 4),
    icon: visual.icon,
    color: visual.color,
  };
}

function inferOpportunities({ name = '', type = '' }) {
  const hay = `${name} ${type}`;
  if (classifySector(hay).length > 0) return [];
  for (const rule of OPPORTUNITY_RULES) {
    if (rule.match.test(hay)) return rule.opps.slice(0, 4);
  }
  return [];
}

function isOpportunityTarget({ name = '', type = '' } = {}) {
  return inferOpportunities({ name, type }).length > 0;
}

function classify(input) {
  const name = input.name || '';
  const type = input.type || '';
  const nameTypeHay = `${name} ${type}`;

  if (isOpportunityTarget({ name, type })) {
    return buildClassifyResult([]);
  }

  let cats = classifySector(nameTypeHay);
  if (!cats.length && input.extraText) {
    cats = classifySector(`${nameTypeHay} ${input.extraText}`);
  }
  return buildClassifyResult(cats);
}

function reclassifyStored(company) {
  return classify({ name: company.name, type: company.type });
}

module.exports = { classify, inferOpportunities, isOpportunityTarget, reclassifyStored };
