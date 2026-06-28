// Shared industry list — onboarding, profile, and scan-result filters.

const AreaHuntIndustries = (() => {
  const OPTIONS = [
    { id: 'all', label: 'All', emoji: '✨', desc: 'Every business' },
    { id: 'design', label: 'Design', emoji: '🎨', cats: ['design'] },
    { id: 'dev', label: 'Dev', emoji: '💻', cats: ['dev'] },
    { id: 'ai', label: 'AI', emoji: '🤖', cats: ['ai'] },
    { id: 'marketing', label: 'Marketing', emoji: '📣', cats: ['marketing'] },
    { id: 'chef', label: 'Chef', emoji: '👨‍🍳', keywords: ['restaurant', 'cafe', 'café', 'kitchen', 'catering', 'food', 'chef', 'cook', 'bistro', 'dining', 'hospitality', 'eatery', 'takeaway'] },
    { id: 'baker', label: 'Baker', emoji: '🥐', keywords: ['bakery', 'pastry', 'patisserie', 'baker', 'bread', 'cake'] },
    { id: 'barista', label: 'Barista', emoji: '☕', keywords: ['barista', 'coffee', 'café', 'cafe', 'espresso'] },
    { id: 'hospitality', label: 'Hospitality', emoji: '🏨', keywords: ['hotel', 'motel', 'resort', 'accommodation', 'events', 'venue', 'front desk', 'reception', 'hospitality'] },
    { id: 'driver', label: 'Driver', emoji: '🚗', keywords: ['driver', 'delivery', 'courier', 'transport', 'logistics', 'truck', 'rideshare', 'freight'] },
    { id: 'cleaner', label: 'Cleaner', emoji: '🧹', keywords: ['clean', 'cleaning', 'janitor', 'domestic', 'commercial clean'] },
    { id: 'trades', label: 'Trades', emoji: '🔧', keywords: ['electrician', 'plumber', 'builder', 'construction', 'trades', 'hvac', 'roofing', 'carpenter', 'painter'] },
    { id: 'warehouse', label: 'Warehouse', emoji: '📦', keywords: ['warehouse', 'picker', 'packer', 'distribution', 'fulfilment', 'fulfillment', 'logistics'] },
    { id: 'retail', label: 'Retail', emoji: '🛍', keywords: ['retail', 'shop', 'store', 'boutique', 'sales assistant', 'cashier'] },
    { id: 'healthcare', label: 'Healthcare', emoji: '🏥', keywords: ['health', 'medical', 'clinic', 'hospital', 'nurse', 'dental', 'pharmacy', 'care', 'physio', 'allied health'] },
    { id: 'education', label: 'Education', emoji: '📚', keywords: ['school', 'education', 'teacher', 'tutor', 'training', 'childcare', 'kindergarten', 'university', 'college'] },
    { id: 'beauty', label: 'Beauty', emoji: '💇', keywords: ['beauty', 'hair', 'salon', 'nails', 'spa', 'barber', 'cosmetic'] },
    { id: 'fitness', label: 'Fitness', emoji: '💪', keywords: ['fitness', 'gym', 'personal trainer', 'yoga', 'pilates', 'sport'] },
    { id: 'security', label: 'Security', emoji: '🛡', keywords: ['security', 'guard', 'concierge', 'surveillance'] },
    { id: 'accounting', label: 'Finance', emoji: '📊', keywords: ['account', 'accounting', 'bookkeep', 'finance', 'tax', 'audit'] },
    { id: 'legal', label: 'Legal', emoji: '⚖', keywords: ['legal', 'law', 'solicitor', 'lawyer', 'paralegal', 'conveyancing'] },
    { id: 'creative', label: 'Creative', emoji: '📸', keywords: ['photo', 'video', 'film', 'production', 'creative', 'animation', 'media'] },
    { id: 'admin', label: 'Admin', emoji: '📋', keywords: ['admin', 'office', 'reception', 'secretary', 'virtual assistant', 'clerical'] },
    { id: 'customer-service', label: 'Support', emoji: '📞', keywords: ['customer service', 'call centre', 'call center', 'support', 'helpdesk'] },
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

  // Onboarding labels (with longer text).
  function onboardingOptions() {
    return OPTIONS.map(o => ({
      id: o.id,
      label: o.id === 'all' ? '✨ All industries' : `${o.emoji} ${o.label}`,
      desc: o.desc || '',
    }));
  }

  return { OPTIONS, BY_ID, matchesFilter, matchesAnyFilter, onboardingOptions };
})();
