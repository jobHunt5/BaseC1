// Server-side port of public/app.js's profileSkillKeywords()/oppMatchesProfile()
// — a background job can't call frontend JS, so this is a deliberate small
// duplicate (the two never share code in this codebase; e.g. enrichService's
// seniority ranking isn't shared with the frontend either).

function profileSkillKeywords(skills) {
  return (skills || []).flatMap(s =>
    String(s).toLowerCase().replace(/[/&]/g, ' ').split(/\s+/).filter(w => w.length > 2),
  );
}

function oppMatchesProfile(opportunity, userKeywords) {
  if (!userKeywords.length) return false;
  const tokens = String(opportunity).toLowerCase().split(/[\s/]+/).filter(t => t.length > 2);
  return userKeywords.some(k => {
    if (k.length < 3) return false;
    return tokens.some(t => t === k || t.includes(k) || k.includes(t));
  });
}

function companyMatchesProfile(company, profile) {
  const keywords = profileSkillKeywords(profile?.skills);
  if (!keywords.length) return false;
  const opps = company?.opportunities || [];
  return opps.some(o => oppMatchesProfile(o, keywords));
}

module.exports = { profileSkillKeywords, oppMatchesProfile, companyMatchesProfile };
