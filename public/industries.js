// Shared industry list — onboarding, profile, and scan-result filters.
// Each option's `icon` is a symbol id rendered via <svg><use href="#icon-<id>">
// from the sprite defined in index.html (see IndustryIcon() below).

const AreaHuntIndustries = (() => {
  const OPTIONS = [
    { id: 'all', label: 'All', icon: 'sparkles', desc: 'Every business' },
    { id: 'design', label: 'Design', icon: 'design', cats: ['design'], roleQuery: 'UX UI product designer' },
    { id: 'dev', label: 'Dev', icon: 'dev', cats: ['dev'], roleQuery: 'software developer engineer' },
    { id: 'ai', label: 'AI', icon: 'ai', cats: ['ai'], roleQuery: 'AI machine learning engineer' },
    { id: 'vr', label: 'VR/AR', icon: 'vr', cats: ['vr'], roleQuery: 'VR AR XR virtual reality developer',
      keywords: ['virtual reality', 'augmented reality', 'mixed reality', 'extended reality', 'immersive tech', 'metaverse', 'spatial computing', 'unity developer', 'unreal engine'] },
    { id: 'marketing', label: 'Marketing', icon: 'marketing', cats: ['marketing'], roleQuery: 'digital marketing' },
    { id: 'chef', label: 'Chef', icon: 'chef', keywords: ['restaurant', 'cafe', 'café', 'kitchen', 'catering', 'food', 'chef', 'cook', 'bistro', 'dining', 'hospitality', 'eatery', 'takeaway'] },
    { id: 'baker', label: 'Baker', icon: 'baker', keywords: ['bakery', 'pastry', 'patisserie', 'baker', 'bread', 'cake'] },
    { id: 'barista', label: 'Barista', icon: 'barista', keywords: ['barista', 'coffee', 'café', 'cafe', 'espresso'] },
    { id: 'hospitality', label: 'Hospitality', icon: 'hospitality', keywords: ['hotel', 'motel', 'resort', 'accommodation', 'events', 'venue', 'front desk', 'reception', 'hospitality'] },
    { id: 'driver', label: 'Driver', icon: 'driver', keywords: ['driver', 'delivery', 'courier', 'transport', 'logistics', 'truck', 'rideshare', 'freight'] },
    { id: 'cleaner', label: 'Cleaner', icon: 'cleaner', keywords: ['clean', 'cleaning', 'janitor', 'domestic', 'commercial clean'] },
    { id: 'trades', label: 'Trades', icon: 'trades', keywords: ['electrician', 'plumber', 'builder', 'construction', 'trades', 'hvac', 'roofing', 'carpenter', 'painter'] },
    { id: 'warehouse', label: 'Warehouse', icon: 'warehouse', keywords: ['warehouse', 'picker', 'packer', 'distribution', 'fulfilment', 'fulfillment', 'logistics'] },
    { id: 'retail', label: 'Retail', icon: 'retail', keywords: ['retail', 'shop', 'store', 'boutique', 'sales assistant', 'cashier'] },
    { id: 'healthcare', label: 'Healthcare', icon: 'healthcare', keywords: ['health', 'medical', 'clinic', 'hospital', 'nurse', 'dental', 'pharmacy', 'care', 'physio', 'allied health'] },
    { id: 'education', label: 'Education', icon: 'education', keywords: ['school', 'education', 'teacher', 'tutor', 'training', 'childcare', 'kindergarten', 'university', 'college'] },
    { id: 'beauty', label: 'Beauty', icon: 'beauty', keywords: ['beauty', 'hair', 'salon', 'nails', 'spa', 'barber', 'cosmetic'] },
    { id: 'fitness', label: 'Fitness', icon: 'fitness', keywords: ['fitness', 'gym', 'personal trainer', 'yoga', 'pilates', 'sport'] },
    { id: 'security', label: 'Security', icon: 'security', keywords: ['security', 'guard', 'concierge', 'surveillance'] },
    { id: 'accounting', label: 'Finance', icon: 'finance', keywords: ['account', 'accounting', 'bookkeep', 'finance', 'tax', 'audit', 'insurance', 'fintech', 'comparison', 'broker', 'lending', 'bank', 'superannuation'] },
    { id: 'legal', label: 'Legal', icon: 'legal', keywords: ['legal', 'law', 'solicitor', 'lawyer', 'paralegal', 'conveyancing'] },
    { id: 'creative', label: 'Creative', icon: 'creative', keywords: ['photo', 'video', 'film', 'production', 'creative', 'animation', 'media'] },
    { id: 'admin', label: 'Admin', icon: 'admin', keywords: ['admin', 'office', 'reception', 'secretary', 'virtual assistant', 'clerical'] },
    { id: 'customer-service', label: 'Support', icon: 'support', keywords: ['customer service', 'call centre', 'call center', 'support', 'helpdesk'] },
    { id: 'engineering', label: 'Engineering', icon: 'engineering', roleQuery: 'engineer', keywords: ['engineer', 'engineering', 'mechanical engineer', 'civil engineer', 'electrical engineer', 'structural engineer', 'chemical engineer'] },
    { id: 'manufacturing', label: 'Manufacturing', icon: 'manufacturing', keywords: ['manufactur', 'factory', 'production line', 'assembly line', 'machinist', 'fabrication'] },
    { id: 'agriculture', label: 'Agriculture', icon: 'agriculture', keywords: ['farm', 'agricultur', 'agronomist', 'livestock', 'crop', 'dairy farm', 'viticulture', 'horticulture', 'orchard'] },
    { id: 'real-estate', label: 'Real Estate', icon: 'real-estate', keywords: ['real estate', 'realty', 'property manage', 'leasing agent', 'estate agent', 'property group'] },
    { id: 'hr', label: 'HR & Recruitment', icon: 'hr', keywords: ['human resources', 'recruit', 'talent acquisition', 'staffing agency', 'headhunt', 'recruitment'] },
    { id: 'sales', label: 'Sales', icon: 'sales', keywords: ['sales', 'business development', 'account executive', 'account manager', 'sales rep'] },
    { id: 'science', label: 'Science & Research', icon: 'science', keywords: ['research institute', 'laboratory', 'scientist', 'r&d', 'science park', 'research centre'] },
    { id: 'government', label: 'Government', icon: 'government', keywords: ['government', 'city council', 'shire council', 'public sector', 'municipal', 'department of', 'local council'] },
    { id: 'veterinary', label: 'Veterinary', icon: 'veterinary', keywords: ['veterinary', 'vet clinic', 'vet hospital', 'animal hospital', 'pet care', 'animal clinic'] },
    { id: 'automotive', label: 'Automotive', icon: 'automotive', keywords: ['automotive', 'mechanic', 'car service', 'panel beater', 'tyre', 'tire', 'auto repair', 'car dealership'] },
    { id: 'arts', label: 'Arts & Entertainment', icon: 'arts', keywords: ['theatre', 'theater', 'gallery', 'museum', 'performing arts', 'orchestra', 'entertainment venue', 'cinema'] },
    { id: 'sports', label: 'Sports & Recreation', icon: 'sports', keywords: ['sports club', 'stadium', 'recreation centre', 'leisure centre', 'swim school', 'sporting club', 'athletic'] },
    { id: 'aviation', label: 'Aviation & Maritime', icon: 'aviation', keywords: ['airline', 'airport', 'aviation', 'maritime', 'shipping line', 'port authority', 'marine', 'vessel'] },
    { id: 'mining', label: 'Mining & Resources', icon: 'mining', keywords: ['mining', 'mine site', 'resources company', 'quarry', 'drilling', 'extraction', 'minerals'] },
    { id: 'nonprofit', label: 'Non-profit', icon: 'nonprofit', keywords: ['charity', 'non-profit', 'nonprofit', 'ngo', 'not-for-profit', 'foundation', 'community services'] },
    { id: 'journalism', label: 'Media & Journalism', icon: 'journalism', keywords: ['journalis', 'newsroom', 'news agency', 'editor', 'publishing house', 'copywriting', 'broadcast', 'magazine'] },
    { id: 'telecom', label: 'Telecom', icon: 'telecom', keywords: ['telecom', 'telecommunications', 'network provider', 'internet service provider', 'mobile carrier', 'broadband'] },
    { id: 'pharma', label: 'Pharma & Biotech', icon: 'pharma', keywords: ['pharmaceutical', 'biotech', 'clinical trial', 'drug development', 'life sciences', 'pharma'] },
    { id: 'travel', label: 'Travel & Tourism', icon: 'travel', keywords: ['travel agency', 'tourism', 'tour operator', 'travel agent', 'tourist information'] },
    { id: 'childcare', label: 'Childcare', icon: 'childcare', keywords: ['childcare', 'daycare', 'early learning', 'nursery', 'preschool', 'long day care'] },
  ];

  const BY_ID = Object.fromEntries(OPTIONS.map(o => [o.id, o]));

  function companyHaystack(company) {
    return [
      company.name,
      company.type,
      ...(company.cats || []),
      ...(company.opportunities || []),
      ...(company.skills || []),
      company.description,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function matchesFilter(company, filterId) {
    if (!filterId || filterId === 'all') return true;
    const def = BY_ID[filterId];
    if (!def) return false;
    const cats = company.cats || [];
    if (def.cats?.some(c => cats.includes(c))) return true;
    if (!def.keywords?.length) return false;
    const hay = companyHaystack(company);
    return def.keywords.some(k => hay.includes(k.toLowerCase()));
  }

  function matchesAnyFilter(company, activeIds) {
    if (!activeIds?.length || activeIds.includes('all')) return true;
    return activeIds.some(id => matchesFilter(company, id));
  }

  // Job-board search phrase for an industry — a role-oriented query
  // ("UX UI product designer") reads very differently to Seek/Indeed than
  // the company-type keywords used for matchesFilter ("café", "restaurant"),
  // so this is its own field rather than reusing `keywords`. Falls back to
  // the plain label for industries that don't have a hand-tuned roleQuery.
  function roleSearchTerm(id) {
    const def = BY_ID[id];
    if (!def || id === 'all') return '';
    return def.roleQuery || def.label;
  }

  // Onboarding labels — icon is rendered separately by the caller (see
  // authFlow.js's chipGroup), label stays plain text (no emoji baked in).
  function onboardingOptions() {
    return OPTIONS.map(o => ({
      id: o.id,
      label: o.id === 'all' ? 'All industries' : o.label,
      icon: o.icon,
      desc: o.desc || '',
    }));
  }

  // Every industry icon lives once in the <svg id="iconSprite"> sprite in
  // index.html as <symbol id="icon-<name>">; this just builds the small
  // <svg><use> snippet that references it, so every caller renders icons
  // identically instead of re-inlining markup.
  function iconSvg(iconId, size = 16) {
    if (!iconId) return '';
    return `<svg class="ind-icon" width="${size}" height="${size}" aria-hidden="true"><use href="#icon-${iconId}"></use></svg>`;
  }

  return { OPTIONS, BY_ID, matchesFilter, matchesAnyFilter, onboardingOptions, iconSvg, roleSearchTerm };
})();
