// AreaHunt map — native Carto tiles, dark / light mode (no CSS filter hacks).

window.AreaHuntMap = (() => {
  const MODE_KEY = 'areahunt_map_mode';

  const TILE = {
    subdomains: 'abcd',
    maxZoom: 19,
    detectRetina: true,
    updateWhenIdle: true,
    keepBuffer: 2,
  };

  const MODES = {
    dark: {
      terrain: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      selection: {
        className: 'selection-rect',
        interactive: false,
        weight: 2,
        color: '#ffffff',
        fillColor: '#ffffff',
        fillOpacity: 0.1,
        dashArray: '8 6',
      },
    },
    light: {
      terrain: 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
      labels: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
      selection: {
        className: 'selection-rect',
        interactive: false,
        weight: 2,
        color: '#6c63ff',
        fillColor: '#6c63ff',
        fillOpacity: 0.12,
        dashArray: '8 6',
      },
    },
  };

  const CAT_RING = {
    design:    '#ff6b9d',
    dev:       '#6c63ff',
    ai:        '#4ecdc4',
    marketing: '#ffa552',
    other:     '#8888aa',
  };

  let _map = null;
  let _terrainLayer = null;
  let _labelsLayer = null;
  let _mode = 'dark';

  function loadMode() {
    try {
      const v = localStorage.getItem(MODE_KEY);
      return v === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function saveMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
  }

  function applyMode(mode) {
    const cfg = MODES[mode];
    if (!_map || !cfg) return;

    if (_terrainLayer) _map.removeLayer(_terrainLayer);
    if (_labelsLayer) _map.removeLayer(_labelsLayer);

    _terrainLayer = L.tileLayer(cfg.terrain, TILE).addTo(_map);
    _labelsLayer = L.tileLayer(cfg.labels, TILE).addTo(_map);

    const el = _map.getContainer();
    el.classList.remove('map-dark', 'map-light');
    el.classList.add(mode === 'light' ? 'map-light' : 'map-dark');

    document.querySelector('.map-panel')?.classList.toggle('map-panel-light', mode === 'light');
    _mode = mode;
  }

  function init(containerId, options = {}) {
    _mode = loadMode();

    _map = L.map(containerId, {
      zoomControl: true,
      attributionControl: false,
      zoomSnap: 1,
      zoomDelta: 1,
      ...options,
    }).setView([-37.8136, 144.9631], 14);

    _map.getContainer().classList.add('areahunt-map');
    applyMode(_mode);

    if (_map.zoomControl) _map.zoomControl.setPosition('bottomright');
    return _map;
  }

  function setMode(mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    if (mode === _mode) return;
    saveMode(mode);
    applyMode(mode);
  }

  function toggleMode() {
    setMode(_mode === 'dark' ? 'light' : 'dark');
    return _mode;
  }

  function getMode() {
    return _mode;
  }

  function selectionStyle() {
    return { ...(MODES[_mode]?.selection || MODES.dark.selection) };
  }

  function categoryRing(cats) {
    const cat = (cats && cats[0]) || 'other';
    return CAT_RING[cat] || CAT_RING.other;
  }

  function shortName(name, max = 16) {
    const n = String(name || 'Company').trim();
    const t = n.length <= max ? n : n.slice(0, max - 1) + '…';
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pinHtml(c, { inner = '', applied = false } = {}) {
    const ring = applied ? '#ff3b3b' : categoryRing(c.cats);
    const cls = applied ? 'map-pin map-pin--applied' : 'map-pin';
    return `<div class="${cls}" style="--pin-ring:${ring}">${inner}</div>`;
  }

  function buildingHtml(c, { inner = '', applied = false } = {}) {
    const ring = applied ? '#ff3b3b' : categoryRing(c.cats);
    const label = shortName(c.name);
    const windows = Array.from({ length: 6 }, (_, i) =>
      `<i class="bld-win${i % 2 === 0 ? ' lit' : ''}"></i>`,
    ).join('');

    return `
      <div class="map-building${applied ? ' map-building--applied' : ''}" style="--cat:${ring}">
        <div class="bld-tag">${label}</div>
        <div class="bld-scene">
          <div class="bld-platform"></div>
          <div class="bld-tower">
            <div class="bld-roof"></div>
            <div class="bld-right"></div>
            <div class="bld-front">
              <div class="bld-logo">${inner}</div>
              <div class="bld-windows">${windows}</div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function markerLayout(c, selected, opts = {}) {
    const applied = !!opts.applied;
    if (selected) {
      return {
        html: buildingHtml(c, { ...opts, applied }),
        className: 'map-building-wrap',
        iconSize: [72, 88],
        iconAnchor: [36, 82],
        zIndexOffset: 2500,
      };
    }
    return {
      html: pinHtml(c, { ...opts, applied }),
      className: 'map-pin-wrap',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      zIndexOffset: 0,
    };
  }

  return {
    init,
    setMode,
    toggleMode,
    getMode,
    categoryRing,
    selectionStyle,
    pinHtml,
    buildingHtml,
    markerLayout,
    CAT_RING,
  };
})();
