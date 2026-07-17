(function () {
  const COLORS = {
    blue: '#3987e5', aqua: '#199e70', yellow: '#c98500', green: '#008300',
    violet: '#9085e9', red: '#e66767', magenta: '#d55181', orange: '#d95926',
  };
  const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
  const INK = { primary: '#f0f0f8', muted: '#8888aa', grid: '#2e2e3f', surface: '#1e1e2a' };

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let tipEl;
  function tooltip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tooltip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const t = tooltip();
    t.innerHTML = html;
    t.style.display = 'block';
    const rect = t.getBoundingClientRect();
    let left = x + 14, top = y - rect.height - 10;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
    if (top < 8) top = y + 14;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  function fmtCompact(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function niceMax(max) {
    if (max <= 0) return 4;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    const norm = max / pow;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * pow;
  }

  function shortDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // series: [{ label, color, points: number[] }], labels: string[] (ISO days)
  function lineMulti(el, { series, labels }) {
    const W = Math.max(280, el.clientWidth || 600);
    const H = 220;
    const padL = 38, padR = 14, padT = 16, padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = labels.length;
    const maxVal = niceMax(Math.max(1, ...series.flatMap(s => s.points)));
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const xAt = i => padL + i * stepX;
    const yAt = v => padT + plotH - (v / maxVal) * plotH;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = padT + plotH - f * plotH;
      const val = Math.round(f * maxVal);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${INK.grid}" stroke-width="1"/>
        <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${INK.muted}">${fmtCompact(val)}</text>`;
    }).join('');

    const tickIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    const xLabels = tickIdx.map(i => `
      <text x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${INK.muted}">${escHtml(shortDate(labels[i]))}</text>
    `).join('');

    const paths = series.map(s => {
      const d = s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
      const last = s.points.length - 1;
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${xAt(last).toFixed(1)}" cy="${yAt(s.points[last]).toFixed(1)}" r="4" fill="${s.color}" stroke="${INK.surface}" stroke-width="2"/>`;
    }).join('');

    const legend = series.map(s => `<span class="chart-legend-item"><span class="chart-dot" style="background:${s.color}"></span>${escHtml(s.label)}</span>`).join('');

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="chart-svg" preserveAspectRatio="none">
        ${gridLines}
        ${paths}
        ${xLabels}
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
        <line class="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="${INK.muted}" stroke-width="1" opacity="0"/>
      </svg>
      <div class="chart-legend">${legend}</div>`;

    const svg = el.querySelector('svg');
    const hit = el.querySelector('.chart-hit');
    const crosshair = el.querySelector('.chart-crosshair');
    hit.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = W / rect.width;
      const localX = (e.clientX - rect.left) * scaleX;
      let idx = Math.round((localX - padL) / (stepX || 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      const cx = xAt(idx).toFixed(1);
      crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx);
      crosshair.setAttribute('opacity', '1');
      const rows = series.map(s => `<div class="chart-tip-row"><span class="chart-dot" style="background:${s.color}"></span>${escHtml(s.label)}<b>${fmtCompact(s.points[idx])}</b></div>`).join('');
      showTip(`<div class="chart-tip-title">${escHtml(shortDate(labels[idx]))}</div>${rows}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => { crosshair.setAttribute('opacity', '0'); hideTip(); });
  }

  // items: [{ label, value, color? }]
  function barH(el, { items, color = COLORS.blue, valueFmt = fmtCompact }) {
    if (!items.length) { el.innerHTML = '<div class="admin-empty-hint">No data yet.</div>'; return; }
    const max = Math.max(1, ...items.map(i => i.value));
    el.innerHTML = items.map((it, idx) => {
      const pct = Math.max(2, (it.value / max) * 100);
      return `
        <div class="chart-hbar-row" data-idx="${idx}">
          <div class="chart-hbar-label">${escHtml(it.label)}</div>
          <div class="chart-hbar-track"><div class="chart-hbar-fill" style="width:${pct}%; background:${it.color || color}"></div></div>
          <div class="chart-hbar-value">${valueFmt(it.value)}</div>
        </div>`;
    }).join('');
    el.querySelectorAll('.chart-hbar-row').forEach((row, idx) => {
      row.addEventListener('mousemove', (e) => showTip(`<b>${escHtml(items[idx].label)}</b>: ${valueFmt(items[idx].value)}`, e.clientX, e.clientY));
      row.addEventListener('mouseleave', hideTip);
    });
  }

  // items: [{ label, value, color }] — small fixed-category vertical bars (status buckets etc)
  function buckets(el, { items }) {
    const max = Math.max(1, ...items.map(i => i.value));
    const W = 320, H = 140, padB = 22, padT = 22;
    const bw = 46, gap = 16;
    const totalW = items.length * bw + (items.length - 1) * gap;
    const startX = (W - totalW) / 2;
    const bars = items.map((it, i) => {
      const h = Math.max(3, (it.value / max) * (H - padT - padB));
      const x = startX + i * (bw + gap);
      const y = H - padB - h;
      return `<rect class="chart-bucket-bar" data-idx="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="4" fill="${it.color}"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle" font-size="10" fill="${INK.muted}">${escHtml(it.label)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="${INK.primary}" font-weight="600">${it.value}</text>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${bars}</svg>`;
    el.querySelectorAll('.chart-bucket-bar').forEach((bar, idx) => {
      bar.addEventListener('mousemove', (e) => showTip(`<b>${escHtml(items[idx].label)}</b>: ${items[idx].value}`, e.clientX, e.clientY));
      bar.addEventListener('mouseleave', hideTip);
    });
  }

  function meter(pct, color = COLORS.blue) {
    const p = Math.max(0, Math.min(100, pct));
    return `<div class="chart-meter"><div class="chart-meter-fill" style="width:${p}%; background:${color}"></div></div>`;
  }

  window.AdminCharts = { lineMulti, barH, buckets, meter, fmtCompact, COLORS, STATUS };
})();
