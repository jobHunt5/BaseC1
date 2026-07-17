// Shared per-user visual identity for generated documents (resume, cover
// letter). Deterministic hash -> hue so the same person's documents always
// match, and different people get a genuinely different accent instead of
// every PDF looking identical — the "individual design" without needing a
// library of hand-built templates.

function stringHue(s) {
  let h = 0;
  for (let i = 0; i < String(s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function accentFor(profile) {
  const seed = `${profile?.name || ''}|${profile?.email || profile?.senderEmail || ''}`;
  const hue = stringHue(seed || 'areahunt');
  return {
    hue,
    strong: `hsl(${hue}, 58%, 36%)`,
    mid: `hsl(${hue}, 48%, 92%)`,
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { accentFor, escapeHtml };
