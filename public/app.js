// AreaHunt front-end. Talks to the backend at /api/*.
// All "demo data" from the original mockup is gone — companies and jobs come
// from real API calls.

const App = (() => {
  const state = {
    map: null,
    drawLayer: null,
    selectionRect: null,
    companies: [],          // current scan result, already enriched server-side
    markers: [],
    activeCat: 'all',
    activeCats: ['all'],
    view: 'scan',           // 'scan' | 'pipeline'
    pipelineTab: 'interested',
    isDrawing: false,
    drawStart: null,
    mouseDown: false,
    selectedId: null,
    selBounds: null,
    savedAreas: [],
    areaLayer: null,
    pipelineCompanies: [],
    enrichConcurrency: 6,
  };

  const _enriching = new Set();

  const AREAS_KEY = 'areahunt.areas.v1';

  // ---- init ---------------------------------------------------------------

  let appStarted = false;

  function init() {
    AuthGate.boot((sess) => {
      applyUserProfile(sess.profile);
      if (!appStarted) {
        appStarted = true;
        initApp();
      } else {
        renderCompanies(true);
        if (state.companies.length) addMarkers();
      }
    });
  }

  function applyUserProfile(userProfile) {
    if (!userProfile) return;
    profile = {
      name: userProfile.name || '',
      skills: userProfile.skills || [],
      city: userProfile.city || '',
      portfolio: userProfile.portfolioUrl || userProfile.portfolio || '',
      pitch: userProfile.pitch || '',
      signature: userProfile.signature || userProfile.name || '',
      ...userProfile,
    };
    if (userProfile.jobSectors?.length && !userProfile.jobSectors.includes('all')) {
      state.activeCats = [...userProfile.jobSectors];
      state.activeCat = state.activeCats[0] || 'all';
    }
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
    renderIndustryFilters();
  }

  function initApp() {
    state.map = AreaHuntMap.init('map');
    document.querySelector('.map-panel').classList.toggle('draw-mode', state.isDrawing);
    state.drawLayer = L.layerGroup().addTo(state.map);
    state.areaLayer = L.layerGroup().addTo(state.map);
    loadSavedAreas();
    renderSavedAreas();

    // Belt-and-braces: ensure the detail panel/backdrop start fully closed,
    // even if a previous DOM state (e.g. live-reload or back-forward cache)
    // left .open on them.
    document.getElementById('detailPanel').classList.remove('open');
    document.getElementById('detailBackdrop').classList.remove('show');
    state.selectedId = null;

    // Marker clustering only at low zooms so the user normally sees real
    // company logos — clusters just stop the map exploding when zoomed out.
    state.clusterLayer = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 28,
      disableClusteringAtZoom: 16,
      animateAddingMarkers: false,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        // Borrow the first child marker's favicon to give the cluster a real
        // identity rather than a generic blue dot.
        const child = cluster.getAllChildMarkers()[0];
        let img = '';
        if (child && child.options && child.options.icon && child.options.icon.options.html) {
          const m = child.options.icon.options.html.match(/<img[^>]+>/);
          if (m) img = m[0];
        }
        const size = count > 99 ? 46 : count > 9 ? 40 : 36;
        return L.divIcon({
          html: `<div class="cluster-bubble" style="width:${size}px;height:${size}px">
                   ${img ? `<div class="cluster-bg">${img}</div>` : ''}
                   <span class="cluster-count">${count}</span>
                 </div>`,
          className: '',
          iconSize: [size, size],
        });
      },
    }).addTo(state.map);

    state.map.on('mousedown', onMapMouseDown);
    state.map.on('mousemove', onMapMouseMove);
    state.map.on('mouseup', onMapMouseUp);

    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') geocodeSearch();
    });

    // Event delegation for company card clicks — Safari-safe (handles nested links).
    // pointerdown fires before background re-renders can cancel a delayed click.
    const listEl = document.getElementById('companyList');
    listEl.addEventListener('pointerdown', onCompanyListActivate, { passive: true });
    listEl.addEventListener('click', onCompanyListActivate);

    const pipelineEl = document.getElementById('pipelineList');
    pipelineEl.addEventListener('pointerdown', onCompanyListActivate, { passive: true });
    pipelineEl.addEventListener('click', onCompanyListActivate);

    // Safari back-forward cache can restore an open detail overlay that blocks the map.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      document.getElementById('detailPanel').classList.remove('open');
      document.getElementById('detailBackdrop').classList.remove('show');
      state.selectedId = null;
    });

    // Close detail panel with Esc.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.getElementById('profileModal').classList.contains('show')) {
          closeProfile();
        } else if (document.getElementById('detailPanel').classList.contains('open')) {
          closeDetail();
        }
      }
    });

    loadProfile();
    renderIndustryFilters();
    refreshHealth();
    restoreSessionScan();
    syncMapModeBtn();
    refreshPipelineCounts();
    setView('scan', { silent: true });
  }

  function openAccountMenu() {
    openProfile();
  }

  function logout() {
    closeProfile();
    AuthGate.logout();
  }

  function syncMapModeBtn() {
    const btn = document.getElementById('mapModeBtn');
    if (!btn) return;
    const dark = AreaHuntMap.getMode() === 'dark';
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark ? 'Switch to light map' : 'Switch to dark map';
    btn.setAttribute('aria-label', btn.title);
  }

  function toggleMapMode() {
    AreaHuntMap.toggleMode();
    syncMapModeBtn();
  }

  const SESSION_SCAN_KEY = 'areahunt_last_scan';

  function saveSessionScan(bounds) {
    try {
      sessionStorage.setItem(SESSION_SCAN_KEY, JSON.stringify({
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      }));
    } catch {}
  }

  function clearSessionScan() {
    try { sessionStorage.removeItem(SESSION_SCAN_KEY); } catch {}
  }

  /** Only restore companies from the last scan area — never load the whole DB. */
  async function restoreSessionScan() {
    let bbox = null;
    try {
      const raw = sessionStorage.getItem(SESSION_SCAN_KEY);
      if (raw) bbox = JSON.parse(raw);
    } catch {}
    if (!bbox || [bbox.south, bbox.west, bbox.north, bbox.east].some(v => typeof v !== 'number')) {
      updateStats();
      return;
    }
    try {
      const q = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
      const data = await fetch(`/api/companies/in-bounds?bbox=${encodeURIComponent(q)}`).then(r => r.json());
      state.companies = data.companies || [];
      state.selBounds = L.latLngBounds(
        [bbox.south, bbox.west],
        [bbox.north, bbox.east],
      );
      state.drawLayer.clearLayers();
      state.drawLayer.addLayer(L.rectangle(state.selBounds, AreaHuntMap.selectionStyle()));
      document.getElementById('scanBtn').style.display = '';
      updateAreaActions();
      state.map.fitBounds(state.selBounds, { padding: [40, 40] });
      renderCompanies(true);
      addMarkers();
      updateStats();
      if (state.companies.some(c => !c.enriched_at && c.website)) {
        backgroundEnrichAll();
      }
    } catch {
      updateStats();
    }
  }

  let _lastCardOpenAt = 0;
  function onCompanyListActivate(e) {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('.action-btn')) return;
    if (e.target.closest('a.contact-chip, a.team-mini')) return;
    const card = e.target.closest('.company-card');
    if (!card || !card.dataset.id) return;
    const now = Date.now();
    if (e.type === 'click' && now - _lastCardOpenAt < 350) return;
    _lastCardOpenAt = now;
    openDetail(card.dataset.id);
  }

  // ---- profile (localStorage) --------------------------------------------

  const PROFILE_KEY = 'areahunt.profile.v1';
  let profile = {
    name: '', skills: [], city: '', portfolio: '', pitch: '', signature: '', senderEmail: '',
  };
  const _outreachVariants = {};

  function loadProfile() {
    if (typeof AuthGate.isLoggedIn === 'function' && AuthGate.isLoggedIn()) {
      applyUserProfile(AuthGate.getProfile());
      return;
    }
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) profile = { ...profile, ...JSON.parse(raw) };
    } catch {}
  }

  function readProfileChipSelection(containerId) {
    const sel = [];
    document.querySelectorAll(`#${containerId} .chip-opt.on`).forEach(b => {
      if (b.dataset.id) sel.push(b.dataset.id);
    });
    return sel;
  }

  function renderProfileChipGroup(containerId, options, selected, { exclusiveAll } = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const sel = new Set(selected?.length ? selected : []);
    if (!sel.size && exclusiveAll) sel.add('all');
    el.innerHTML = options.map(o => {
      const id = o.id;
      const label = o.emoji && o.label ? `${o.emoji} ${o.label}` : (o.label || id);
      return `<button type="button" class="chip-opt ${sel.has(id) ? 'on' : ''}" data-id="${id}">${escapeHtml(label)}</button>`;
    }).join('');
    el.querySelectorAll('.chip-opt').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (exclusiveAll && id === 'all') {
          el.querySelectorAll('.chip-opt').forEach(b => b.classList.remove('on'));
          btn.classList.add('on');
          return;
        }
        if (exclusiveAll) el.querySelector('[data-id="all"]')?.classList.remove('on');
        btn.classList.toggle('on');
        if (exclusiveAll && !el.querySelector('.chip-opt.on')) {
          el.querySelector('[data-id="all"]')?.classList.add('on');
        }
      };
    });
  }

  function renderProfileIndustryChips(selected = []) {
    if (typeof AreaHuntIndustries === 'undefined') return;
    const opts = AreaHuntIndustries.OPTIONS.map(o => ({
      id: o.id,
      label: o.id === 'all' ? 'All' : o.label,
      emoji: o.emoji,
    }));
    renderProfileChipGroup('profIndustries', opts, selected, { exclusiveAll: true });
  }

  function renderProfileEducation(education = []) {
    const list = document.getElementById('profEduList');
    if (!list) return;
    const rows = education.length ? education : [{ degree: '', field: '', institution: '', year: '' }];
    list.innerHTML = rows.map((edu, idx) => `
      <div class="prof-edu-row" data-idx="${idx}">
        <input class="form-input" placeholder="Degree (e.g. Bachelor of Design)" data-field="degree" value="${escapeAttr(edu.degree || '')}" />
        <input class="form-input" placeholder="Field of study" data-field="field" value="${escapeAttr(edu.field || '')}" />
        <input class="form-input" placeholder="Institution" data-field="institution" value="${escapeAttr(edu.institution || '')}" />
        <input class="form-input" placeholder="Year" data-field="year" value="${escapeAttr(edu.year || '')}" />
        ${idx > 0 ? '<button type="button" class="link-btn-small prof-remove-edu">Remove</button>' : ''}
      </div>`).join('');
    list.querySelectorAll('.prof-remove-edu').forEach(btn => {
      btn.onclick = () => btn.closest('.prof-edu-row')?.remove();
    });
  }

  function collectProfileEducation() {
    const out = [];
    document.querySelectorAll('.prof-edu-row').forEach(row => {
      const entry = {};
      row.querySelectorAll('[data-field]').forEach(inp => {
        entry[inp.dataset.field] = inp.value.trim();
      });
      if (entry.degree || entry.field || entry.institution) out.push(entry);
    });
    return out;
  }

  function populateProfileForm(p) {
    document.getElementById('profName').value = p.name || '';
    document.getElementById('profCity').value = p.city || '';
    document.getElementById('profPhone').value = p.phone || '';
    document.getElementById('profSkills').value = (p.skills || []).join(', ');
    document.getElementById('profPortfolio').value = p.portfolioUrl || p.portfolio || '';
    document.getElementById('profPortfolioRequired').checked = p.portfolioRequired !== false;
    document.getElementById('profPortfolioNotes').value = p.portfolioNotes || '';
    document.getElementById('profPitch').value = p.pitch || '';
    document.getElementById('profSig').value = p.signature || '';
    document.getElementById('profSenderEmail').value = p.senderEmail || '';
    document.getElementById('profExpYears').value = p.experienceYears || '';
    document.getElementById('profCurrentRole').value = p.currentRole || '';
    document.getElementById('profExpSummary').value = p.experienceSummary || '';
    document.getElementById('profQuals').value = (p.qualifications || []).join(', ');
    renderProfileIndustryChips(p.jobSectors || []);
    const formOpts = AuthGate.getProfileFormOptions?.() || {};
    renderProfileChipGroup('profEmployment', formOpts.employmentTypes || [], p.employmentTypes || []);
    renderProfileChipGroup('profWorkMode', formOpts.workModes || [], p.workModes || []);
    renderProfileEducation(p.education || []);
    const addEdu = document.getElementById('profAddEdu');
    if (addEdu) {
      addEdu.onclick = () => {
        const edu = collectProfileEducation();
        edu.push({ degree: '', field: '', institution: '', year: '' });
        renderProfileEducation(edu);
      };
    }
  }

  function collectProfileForm(base = {}) {
    const portfolioVal = document.getElementById('profPortfolio').value.trim();
    const skills = document.getElementById('profSkills').value.split(',').map(s => s.trim()).filter(Boolean);
    const quals = document.getElementById('profQuals').value.split(',').map(s => s.trim()).filter(Boolean);
    const jobSectors = readProfileChipSelection('profIndustries');
    const name = document.getElementById('profName').value.trim();
    return {
      ...base,
      name,
      city: document.getElementById('profCity').value.trim(),
      phone: document.getElementById('profPhone').value.trim(),
      jobSectors: jobSectors.length ? jobSectors : ['all'],
      employmentTypes: readProfileChipSelection('profEmployment'),
      workModes: readProfileChipSelection('profWorkMode'),
      education: collectProfileEducation(),
      experienceYears: document.getElementById('profExpYears').value || '',
      currentRole: document.getElementById('profCurrentRole').value.trim(),
      experienceSummary: document.getElementById('profExpSummary').value.trim(),
      qualifications: quals,
      skills,
      portfolio: portfolioVal,
      portfolioUrl: portfolioVal,
      portfolioRequired: !!document.getElementById('profPortfolioRequired').checked,
      portfolioNotes: document.getElementById('profPortfolioNotes').value.trim(),
      pitch: document.getElementById('profPitch').value.trim(),
      signature: document.getElementById('profSig').value.trim() || name,
      senderEmail: document.getElementById('profSenderEmail').value.trim(),
    };
  }

  async function openProfile() {
    let p = profile;
    const sess = AuthGate.getSession?.();
    if (sess?.token) {
      try {
        p = await AuthGate.refreshProfile() || AuthGate.getProfile();
        applyUserProfile(p);
      } catch {
        p = AuthGate.getProfile() || profile;
        applyUserProfile(p);
      }
    } else {
      loadProfile();
      p = profile;
    }
    populateProfileForm(p);
    document.getElementById('profileModal').classList.add('show');
  }

  function closeProfile() {
    document.getElementById('profileModal').classList.remove('show');
  }
  function closeProfileBackdrop(e) {
    if (e.target.id === 'profileModal') closeProfile();
  }

  async function saveProfile() {
    const sess = AuthGate.getSession?.();
    let base = profile;
    if (sess?.token) {
      try {
        base = await AuthGate.refreshProfile() || AuthGate.getProfile() || profile;
      } catch {
        base = AuthGate.getProfile() || profile;
      }
    }
    profile = collectProfileForm(base);
    if (!profile.name) {
      toast('Please enter your name', 'error');
      return;
    }
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
    const isComplete = !AuthGate.profileNeedsOnboarding?.(profile);
    try {
      if (sess?.token) {
        const saved = await AuthGate.saveProfileToServer(profile, isComplete);
        if (saved) applyUserProfile(saved);
        closeProfile();
        toast('Profile saved to your account', 'success');
      } else {
        closeProfile();
        toast('Saved on this device — sign in to sync', 'success');
      }
    } catch (err) {
      toast('Save failed: ' + (err.message || 'try again'), 'error');
    }
    renderCompanies();
    if (state.selectedId) openDetail(state.selectedId);
  }

  async function refreshHealth() {
    try {
      const h = await fetch('/api/health').then(r => r.json());
      if (h.provider === 'google' && !h.hasGoogleKey) {
        toast('Provider is set to Google but no API key is configured.', 'error');
      }
      state.hasSerperKey = !!h.hasSerperKey;
      state.hasOpenAiKey = !!h.hasOpenAiKey;
      state.hasSmtp = !!h.hasSmtp;
      state.enrichLimit = h.enrichLimit || 0;
      state.enrichConcurrency = h.enrichConcurrency || 6;
      const banner = document.getElementById('coverageBanner');
      if (banner && h.sparseCoverage && h.coverageHint) {
        banner.style.display = '';
        banner.innerHTML = `<strong>Sparse scan mode</strong> — ${escapeHtml(h.coverageHint)}`;
      } else if (banner) {
        banner.style.display = 'none';
      }
    } catch {}
  }

  async function loadSavedCompanies() {
    // Deprecated — use restoreSessionScan() so refresh never loads the entire DB.
    return restoreSessionScan();
  }

  // ---- drawing ------------------------------------------------------------

  function toggleDraw() {
    state.isDrawing = !state.isDrawing;
    const btn = document.getElementById('drawBtn');
    btn.classList.toggle('active', state.isDrawing);
    btn.textContent = state.isDrawing ? '✕ Cancel draw' : '✦ Draw area';
    document.querySelector('.map-panel').classList.toggle('draw-mode', state.isDrawing);
    document.getElementById('mapHint').innerHTML = state.isDrawing
      ? '<strong>Draw mode on</strong> — click and drag to select area'
      : '<strong>Draw mode off</strong> — click "Draw area" then drag on the map';
    state.map.dragging[state.isDrawing ? 'disable' : 'enable']();
  }

  function onMapMouseDown(e) {
    if (!state.isDrawing) return;
    state.mouseDown = true;
    state.drawStart = e.latlng;
    state.drawLayer.clearLayers();
    state.selectionRect = null;
  }

  function onMapMouseMove(e) {
    if (!state.isDrawing || !state.mouseDown || !state.drawStart) return;
    const bounds = L.latLngBounds(state.drawStart, e.latlng);
    if (state.selectionRect) state.drawLayer.removeLayer(state.selectionRect);
    state.selectionRect = L.rectangle(bounds, AreaHuntMap.selectionStyle());
    state.drawLayer.addLayer(state.selectionRect);
  }

  function onMapMouseUp(e) {
    if (!state.isDrawing || !state.mouseDown) return;
    state.mouseDown = false;
    if (!state.drawStart) return;
    state.selBounds = L.latLngBounds(state.drawStart, e.latlng);
    state.drawStart = null;
    if (state.selBounds.getNorth() !== state.selBounds.getSouth()) {
      document.getElementById('scanBtn').style.display = '';
      updateAreaActions();
      toggleDraw();
    }
  }

  // ---- saved / done scan areas (localStorage) ----------------------------

  function loadSavedAreas() {
    try {
      const raw = localStorage.getItem(AREAS_KEY);
      state.savedAreas = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.savedAreas)) state.savedAreas = [];
    } catch {
      state.savedAreas = [];
    }
  }

  function persistSavedAreas() {
    try { localStorage.setItem(AREAS_KEY, JSON.stringify(state.savedAreas)); } catch {}
  }

  function bboxFromBounds(bounds) {
    return {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
  }

  function boundsOverlap(a, b, threshold = 0.2) {
    const latOverlap = Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south));
    const lngOverlap = Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west));
    if (latOverlap <= 0 || lngOverlap <= 0) return false;
    const intersect = latOverlap * lngOverlap;
    const areaA = Math.max((a.north - a.south) * (a.east - a.west), 1e-9);
    return intersect / areaA >= threshold;
  }

  function isBoundsDone(bounds) {
    const bbox = bboxFromBounds(bounds);
    return state.savedAreas.some(a => a.status === 'done' && boundsOverlap(bbox, a));
  }

  function renderSavedAreas() {
    if (!state.areaLayer) return;
    state.areaLayer.clearLayers();
    state.savedAreas.forEach(a => {
      const bounds = L.latLngBounds([a.south, a.west], [a.north, a.east]);
      const style = a.status === 'done'
        ? { color: '#43a047', fillColor: '#43a047', fillOpacity: 0.14, weight: 2, dashArray: '6 4', interactive: false }
        : { color: '#6c63ff', fillColor: '#6c63ff', fillOpacity: 0.1, weight: 2, dashArray: '4 8', interactive: false };
      state.areaLayer.addLayer(L.rectangle(bounds, style));
    });
  }

  function updateAreaActions() {
    const el = document.getElementById('areaActions');
    if (!el) return;
    if (!state.selBounds) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const bbox = bboxFromBounds(state.selBounds);
    const doneBtn = el.querySelector('[onclick*="markAreaDone"]');
    const saveBtn = el.querySelector('[onclick*="saveArea"]');
    const isDone = state.savedAreas.some(a => a.status === 'done' && boundsOverlap(bbox, a, 0.5));
    const isSaved = state.savedAreas.some(a => a.status === 'saved' && boundsOverlap(bbox, a, 0.5));
    if (doneBtn) {
      doneBtn.textContent = isDone ? '✓ Done' : '✓ Mark done';
      doneBtn.disabled = isDone;
    }
    if (saveBtn) {
      saveBtn.textContent = isSaved ? '🔖 Saved' : '🔖 Save area';
      saveBtn.disabled = isSaved;
    }
  }

  function markAreaDone() {
    if (!state.selBounds) return toast('Draw an area first', 'error');
    const bbox = { ...bboxFromBounds(state.selBounds), status: 'done', id: Date.now(), at: Date.now() };
    state.savedAreas = state.savedAreas.filter(a =>
      !(a.status === 'done' && boundsOverlap(bbox, a, 0.5)),
    );
    state.savedAreas.push(bbox);
    persistSavedAreas();
    renderSavedAreas();
    updateAreaActions();
    toast('Area marked done — you\'ll be warned before re-scanning here', 'success');
  }

  function saveArea() {
    if (!state.selBounds) return toast('Draw an area first', 'error');
    const bbox = { ...bboxFromBounds(state.selBounds), status: 'saved', id: Date.now(), at: Date.now() };
    state.savedAreas = state.savedAreas.filter(a =>
      !(a.status === 'saved' && boundsOverlap(bbox, a, 0.5)),
    );
    state.savedAreas.push(bbox);
    persistSavedAreas();
    renderSavedAreas();
    updateAreaActions();
    toast('Area saved on map for reference', 'success');
  }

  // ---- scan ---------------------------------------------------------------

  async function scanArea() {
    if (!state.selBounds) return;
    if (isBoundsDone(state.selBounds)) {
      const ok = window.confirm(
        'This area overlaps one you marked as done. Scan again anyway?',
      );
      if (!ok) return;
    }
    const btn = document.getElementById('scanBtn');
    btn.textContent = '⏳ Scanning…';
    btn.disabled = true;

    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    document.querySelector('.main').appendChild(bar);

    const progress = document.getElementById('scanProgress');
    progress.classList.add('show');
    progress.innerHTML = `<strong>Scanning…</strong> finding businesses, looking up careers pages, pulling job listings. This can take ~30s for a busy area.`;

    const payload = {
      south: state.selBounds.getSouth(),
      west: state.selBounds.getWest(),
      north: state.selBounds.getNorth(),
      east: state.selBounds.getEast(),
    };

    try {
      const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      state.companies = data.companies || [];
      saveSessionScan(state.selBounds);
      renderCompanies(true);
      addMarkers();
      updateStats();
      toast(`Found ${data.count} businesses — loading contact info`, 'success');
      // Kick off background enrichment for everything else.
      backgroundEnrichAll();
    } catch (err) {
      console.error(err);
      toast('Scan failed: ' + err.message, 'error');
    } finally {
      bar.remove();
      btn.textContent = '⚡ Scan companies';
      btn.disabled = false;
      btn.style.display = 'none';
      progress.classList.remove('show');
    }
  }

  // ---- markers ------------------------------------------------------------

  function isAppliedCompany(c) {
    return c.status === 'applied' || hasAppliedJob(c);
  }

  function companyPassesIndustryFilter(c) {
    if (typeof AreaHuntIndustries !== 'undefined') {
      return AreaHuntIndustries.matchesAnyFilter(c, state.activeCats);
    }
    const cats = c.cats || [];
    return state.activeCats.includes('all') || state.activeCats.some(id => cats.includes(id));
  }

  function companiesForMap() {
    return state.companies.filter(c => {
      if (c.status === 'skipped') return false;
      return companyPassesIndustryFilter(c);
    });
  }

  function addMarkers() {
    if (state.clusterLayer) state.clusterLayer.clearLayers();
    state.markers = [];
    const layers = [];
    companiesForMap().forEach(c => {
      const fav = bestLogoUrl(c);
      const fb  = googleFavicon(c.website, 128);
      const init = initial(c.name);
      const inner = fav
        ? `<img src="${escapeAttr(fav)}" alt=""
                onerror="if(this.dataset.f!=='1'){this.dataset.f='1';this.src='${escapeAttr(fb || '')}'}else{this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${init}'}))}" />`
        : `<span>${c.icon || init}</span>`;
      const selected = String(state.selectedId) === String(c.id);
      const layout = AreaHuntMap.markerLayout(c, selected, {
        inner,
        applied: isAppliedCompany(c),
      });
      const icon = L.divIcon({
        html: layout.html,
        className: layout.className,
        iconSize: layout.iconSize,
        iconAnchor: layout.iconAnchor,
      });
      const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: layout.zIndexOffset })
        .bindPopup(`<div class="popup-name">${escapeHtml(c.name)}</div><div class="popup-type">${escapeHtml(c.type || '')}</div>`);
      m.on('click', () => openDetail(c.id));
      state.markers.push(m);
      layers.push(m);
    });
    if (state.clusterLayer) state.clusterLayer.addLayers(layers);
  }

  // ---- list ---------------------------------------------------------------

  const TRUSTED_LI = new Set(['website', 'linkedin_company', 'serper']);

  function isVerifiedLinkedIn(member) {
    return !!(member?.linkedin_url && TRUSTED_LI.has(member.linkedin_source));
  }

  function isVerifiedEmail(c) {
    return !!(c.email && c.email_verified);
  }

  function emailTrustNote(c) {
    if (!c.email) return '';
    if (isVerifiedEmail(c)) {
      if (c.email_source === 'careers_prefix') return '✓ Verified careers email on their domain';
      if (c.email_source === 'contact_page') return '✓ Contact email on their website';
      return '✓ Email matches their website domain';
    }
    return 'Unverified address — confirm on their site before emailing';
  }

  function emailDomain(email) {
    const m = String(email || '').toLowerCase().match(/@([^@]+)$/);
    return m ? m[1].replace(/^www\./, '') : '';
  }

  function emailMatchesWebsite(email, website) {
    const dom = emailDomain(email);
    const host = hostnameOf(website).replace(/^www\./, '');
    if (!dom || !host) return false;
    return dom === host || dom.endsWith('.' + host) || host.endsWith('.' + dom);
  }

  function isPlausibleExtraEmail(email, c) {
    const e = String(email || '').toLowerCase();
    if (!e || e === (c.email || '').toLowerCase()) return false;
    if (/^(noreply|no-reply|donotreply|mailer-daemon|postmaster|sentry|wix|wordpress|example)@/i.test(e)) return false;
    return !!(c.website && emailMatchesWebsite(e, c.website));
  }

  function buildTrustBanner(c) {
    if (c.enrich_error) {
      return `<div class="trust-banner warn">⚠ ${escapeHtml(c.enrich_error)} — data may be incomplete. <button class="link-btn-small" onclick="App.reVerifyCompany('${escapeAttr(c.id)}')">Try again</button></div>`;
    }
    const parts = [];
    if (isVerifiedEmail(c)) parts.push('verified email on their domain');
    else if (c.email) parts.push('email found but not domain-verified');
    const unverifiedLi = (c.team || []).filter(m => m.linkedin_url && !isVerifiedLinkedIn(m)).length;
    if ((c.team || []).some(isVerifiedLinkedIn)) parts.push('verified LinkedIn where sourced from their site');
    if (unverifiedLi) parts.push(`${unverifiedLi} team link${unverifiedLi !== 1 ? 's' : ''} need manual check`);
    const summary = parts.length ? parts.join(' · ') : 'confirm contact details on their website before outreach';
    return `<div class="trust-banner">Trust mode — ${escapeHtml(summary)}.</div>`;
  }

  function jobTrustLabel(source, job) {
    if (['greenhouse', 'lever', 'workable', 'ashby', 'json-ld'].includes(source)) {
      return '<span class="trust-badge verified">✓ Verified listing</span>';
    }
    if (['seek', 'indeed', 'linkedin-jobs', 'jora'].includes(source)) {
      const label = { seek: 'Seek', indeed: 'Indeed', 'linkedin-jobs': 'LinkedIn Jobs', jora: 'Jora' }[source] || source;
      return `<span class="trust-badge found">Found on ${escapeHtml(label)}</span>`;
    }
    if (source === 'careers-page') {
      const hasRealLink = job?.url && !/^https?:\/\/[^/]+\/?$/i.test(job.url.replace(/\/+$/, ''));
      return hasRealLink
        ? '<span class="trust-badge found">Found on careers page</span>'
        : '<span class="trust-badge warn">Unverified — confirm on their site</span>';
    }
    return '';
  }

  let _renderTimer = null;
  function renderCompanies(immediate = false) {
    if (immediate) {
      clearTimeout(_renderTimer);
      _renderTimer = null;
      renderCompaniesNow();
      return;
    }
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => {
      _renderTimer = null;
      renderCompaniesNow();
    }, 120);
  }

  function filteredCompanies() {
    return state.companies.filter(c => {
      if (c.status === 'skipped') return false;
      return companyPassesIndustryFilter(c);
    });
  }

  async function refreshPipelineCounts() {
    try {
      const [saved, applied] = await Promise.all([
        fetch('/api/companies/pipeline?kind=interested').then(r => r.json()),
        fetch('/api/companies/pipeline?kind=applied').then(r => r.json()),
      ]);
      const savedEl = document.getElementById('tabSaved');
      const appliedEl = document.getElementById('tabApplied');
      const headerApplied = document.getElementById('appliedCount');
      if (savedEl) savedEl.textContent = saved.count ?? 0;
      if (appliedEl) appliedEl.textContent = applied.count ?? 0;
      if (headerApplied) headerApplied.textContent = applied.count ?? 0;
      const navBadge = document.getElementById('navPipelineBadge');
      if (navBadge) navBadge.textContent = (saved.count ?? 0) + (applied.count ?? 0);
    } catch {}
  }

  async function loadPipelineList(kind) {
    const listEl = document.getElementById('pipelineList');
    listEl.innerHTML = '<div class="empty-state"><div class="big-icon">⏳</div><p>Loading…</p></div>';
    try {
      const data = await fetch(`/api/companies/pipeline?kind=${encodeURIComponent(kind)}`).then(r => r.json());
      state.pipelineCompanies = data.companies || [];
      if (!state.pipelineCompanies.length) {
        const label = kind === 'interested' ? 'saved' : 'applied';
        listEl.innerHTML = `<div class="empty-state"><div class="big-icon">${kind === 'interested' ? '💜' : '✓'}</div><h3>No ${label} companies yet</h3><p>Mark companies from your scan results — they appear here across all areas.</p></div>`;
        return;
      }
      listEl.innerHTML = state.pipelineCompanies.map(renderCard).join('');
    } catch {
      listEl.innerHTML = '<div class="empty-state"><div class="big-icon">⚠</div><h3>Could not load</h3><p>Check your connection and try again.</p></div>';
    }
  }

  function renderCompaniesNow() {
    const list = document.getElementById('companyList');
    const filtered = filteredCompanies();
    refreshPipelineCounts();

    if (state.companies.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="big-icon">🗺</div><h3>No area scanned yet</h3><p>Click <strong>Draw area</strong> and drag a rectangle on the map.</p></div>`;
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="big-icon">🔍</div><h3>No matches</h3><p>Try a different filter or scan a larger area.</p></div>`;
      return;
    }

    list.innerHTML = filtered.map(renderCard).join('');
  }

  function renderCard(c) {
    const appliedJobs = (c.jobs || []).filter(j => j.applied).length;
    const totalJobs = (c.jobs || []).length;
    const isApplied = c.status === 'applied' || appliedJobs > 0;
    const isSkipped = c.status === 'skipped';

    const userKeywords = profileSkillKeywords();
    const opps = c.opportunities || [];
    const matchCount = opps.filter(o => oppMatchesProfile(o, userKeywords)).length;
    const oppsHTML = opps.length ? `
      <div class="opps-row">
        ${opps.slice(0, 4).map(o => `<span class="opp-badge ${oppMatchesProfile(o, userKeywords) ? 'match' : ''}">${escapeHtml(o)}</span>`).join('')}
      </div>` : '';

    // Contact chips — only render when we actually have data, so cards stay
    // tight when enrichment hasn't finished yet.
    const chips = [];
    if (c.email && isVerifiedEmail(c)) {
      chips.push(`<a class="contact-chip email verified" href="mailto:${escapeAttr(c.email)}" onclick="event.stopPropagation()" title="${escapeAttr(c.email)}">✉ ${escapeHtml(shortEmail(c.email))}</a>`);
    } else if (c.email) {
      chips.push(`<span class="contact-chip email unverified" title="Unverified — confirm before emailing">✉ ${escapeHtml(shortEmail(c.email))} ?</span>`);
    }
    if (c.website) {
      const host = hostnameOf(c.website);
      chips.push(`<a class="contact-chip site" href="${escapeAttr(c.website)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${escapeAttr(c.website)}">🌐 ${escapeHtml(host)}</a>`);
    }
    if (totalJobs) {
      chips.push(`<span class="contact-chip jobs">💼 ${totalJobs} role${totalJobs !== 1 ? 's' : ''}</span>`);
    }
    const team = c.team || [];
    if (team.length) {
      chips.push(`<span class="contact-chip team">👥 ${team.length} team</span>`);
    }
    const chipsHTML = chips.length ? `<div class="card-chips">${chips.join('')}</div>` : '';

    const descHTML = c.description
      ? `<div class="card-desc">${escapeHtml(c.description.slice(0, 120))}${c.description.length > 120 ? '…' : ''}</div>`
      : '';

    const teamPreview = team.length ? (() => {
      const heads = team.filter(m => /director|founder|co-director|head|partner|ceo|manager/i.test(m.title || '')).slice(0, 2);
      const show = (heads.length ? heads : team).slice(0, 2);
      const extra = team.length - show.length;
      return `<div class="card-team-preview">${show.map(m =>
        isVerifiedLinkedIn(m)
          ? `<a class="team-mini verified" href="${escapeAttr(m.linkedin_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${escapeAttr(m.title || m.name)}">${escapeHtml(m.name.split(' ')[0])} ↗</a>`
          : `<span class="team-mini" title="Search LinkedIn for ${escapeAttr(m.name)}">${escapeHtml(m.name.split(' ')[0])}</span>`
      ).join('')}${extra ? `<span class="team-mini-more">+${extra} more</span>` : ''}</div>`;
    })() : '';

    // Show spinner only while this card is actively being fetched.
    const sid = String(c.id);
    const enrichingHint = _enriching.has(sid)
      ? `<div class="card-enriching">⏳ ${c.enrich_depth === 'full' ? 'deep scanning…' : 'fetching contact info…'}</div>` : '';

    const cid = escapeAttr(c.id);
    const logo = faviconHtml(c, 36);
    const matchBadge = matchCount > 0
      ? `<span class="match-pill" title="${matchCount} of your skills match likely opportunities">🎯 Match</span>` : '';

    return `
      <div class="company-card ${isApplied ? 'applied' : ''} ${isSkipped ? 'skipped' : ''} ${String(state.selectedId) === String(c.id) ? 'selected' : ''}" data-id="${cid}">
        <div class="card-top">
          ${logo}
          <div class="card-info">
            <div class="company-name-row">
              <span class="company-name">${escapeHtml(c.name)}</span>
              ${isApplied ? '<span class="applied-tick" title="Applied">✓</span>' : ''}
              ${matchBadge}
            </div>
            <div class="company-type">${escapeHtml(c.type || 'Business')}${c.address ? ' · ' + escapeHtml(suburbOf(c.address)) : ''}</div>
          </div>
        </div>
        ${chipsHTML}
        ${descHTML}
        ${teamPreview}
        ${oppsHTML}
        ${enrichingHint}
        <div class="card-actions">
          <button class="action-btn ${c.status === 'applied' ? 'applied' : ''}" onclick="event.stopPropagation();App.toggleStatus('${cid}', 'applied')">
            ${c.status === 'applied' ? '✓ Applied' : '✉ Applied'}
          </button>
          <button class="action-btn ${c.status === 'interested' ? 'applied' : ''}" onclick="event.stopPropagation();App.toggleStatus('${cid}', 'interested')">
            ${c.status === 'interested' ? '♥ Saved' : '♡ Save'}
          </button>
          <button class="action-btn skip" onclick="event.stopPropagation();App.toggleStatus('${cid}', 'skipped')" ${c.status === 'skipped' ? 'style="color:var(--red);border-color:var(--red)"' : ''}>✕</button>
        </div>
      </div>`;
  }

  // --- visual helpers ------------------------------------------------------

  // Pick the best logo source we have:
  //   1. logo_url scraped server-side from the site itself
  //      (apple-touch-icon, og:image, or a sized <link rel="icon">) — these
  //      are real brand logos at 152–512px.
  //   2. Google's s2 favicons at sz=128 — always works, ~32px max though.
  //   3. The company's initial in a coloured chip.
  function bestLogoUrl(c) {
    if (c && c.logo_url) return c.logo_url;
    return googleFavicon(c && c.website);
  }
  function googleFavicon(website, size = 128) {
    if (!website) return null;
    try {
      const host = new URL(website).hostname.replace(/^www\./, '');
      return `https://www.google.com/s2/favicons?domain=${host}&sz=${size}`;
    } catch { return null; }
  }
  // Back-compat alias used by older call sites.
  function faviconUrl(website) { return googleFavicon(website); }
  function faviconFallback(website, size = 128) { return googleFavicon(website, size); }

  function faviconHtml(c, sizePx) {
    const bg = c.color || 'rgba(108,99,255,0.15)';
    const fallback = c.icon || initial(c.name);
    const primary  = bestLogoUrl(c);
    const fb       = googleFavicon(c.website, 128);
    if (primary) {
      // Multi-source fallback chain: primary → google → emoji/initial chip.
      return `
        <div class="company-logo" style="background:${bg};width:${sizePx}px;height:${sizePx}px">
          <img src="${escapeAttr(primary)}" alt="" loading="lazy"
               onerror="if(this.dataset.f!=='1'){this.dataset.f='1';this.src='${escapeAttr(fb || '')}'}else{this.style.display='none';this.nextElementSibling.style.display='flex'}"/>
          <span class="logo-fallback" style="display:none">${fallback}</span>
        </div>`;
    }
    return `<div class="company-logo" style="background:${bg};width:${sizePx}px;height:${sizePx}px"><span class="logo-fallback">${fallback}</span></div>`;
  }

  function initial(name) {
    if (!name) return '🏢';
    return escapeHtml(name.trim().charAt(0).toUpperCase());
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url; }
  }

  function shortEmail(e) {
    // keep "careers@x.com" intact, truncate longer ones to fit a card
    if (!e) return '';
    return e.length <= 28 ? e : e.slice(0, 25) + '…';
  }

  function suburbOf(addr) {
    if (!addr) return '';
    const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
    return parts[0] || '';
  }

  // --- team / LinkedIn -----------------------------------------------------

  function australianPlaceOf(addr) {
    if (!addr) return 'Australia';
    const suburb = suburbOf(addr);
    const stateMatch = addr.match(/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/i);
    const stateNames = {
      VIC: 'Victoria', NSW: 'New South Wales', QLD: 'Queensland', WA: 'Western Australia',
      SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory',
    };
    const state = stateMatch ? (stateNames[stateMatch[1].toUpperCase()] || stateMatch[1]) : '';
    return [suburb, state, 'Australia'].filter(Boolean).join(' ');
  }

  function linkedinSearchUrl(name, company, address) {
    const q = encodeURIComponent([name, company, australianPlaceOf(address)].filter(Boolean).join(' ').trim());
    return `https://www.linkedin.com/search/results/people/?keywords=${q}`;
  }

  function avatarInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
  }

  function linkedinCompanyPeopleUrl(c) {
    const url = (c.socials || {}).linkedin || '';
    const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
    if (!m) return null;
    return `https://www.linkedin.com/company/${encodeURIComponent(m[1])}/people/`;
  }

  function linkedinPeopleSearchUrl(c) {
    const q = encodeURIComponent([c.name, australianPlaceOf(c.address)].filter(Boolean).join(' '));
    return `https://www.linkedin.com/search/results/people/?keywords=${q}&origin=FACETED_SEARCH`;
  }

  function renderTeamCard(c, member) {
    const initials = avatarInitials(member.name);
    const hue = stringHue(member.name);
    const verified = isVerifiedLinkedIn(member);
    const profileUrl = verified
      ? member.linkedin_url
      : linkedinSearchUrl(member.name, c.name, c.address);
    const linkLabel = verified
      ? (member.linkedin_source === 'website'
        ? `<span class="li-found">✓ LinkedIn (from their website) ↗</span>`
        : member.linkedin_source === 'linkedin_company'
          ? `<span class="li-found">✓ Verified on company LinkedIn ↗</span>`
          : `<span class="li-found">✓ Verified ↗</span>`)
      : `<span class="li-search">Search LinkedIn ↗</span>`;
    const bioHTML = member.bio
      ? `<div class="team-bio">${escapeHtml(member.bio.slice(0, 140))}${member.bio.length > 140 ? '…' : ''}</div>`
      : '';
    const emailHTML = member.email && emailMatchesWebsite(member.email, c.website)
      ? `<div class="team-email"><a href="mailto:${escapeAttr(member.email)}" onclick="event.stopPropagation()">${escapeHtml(member.email)}</a></div>`
      : '';
    return `
      <a class="team-card ${verified ? 'has-li verified-li' : 'search-li'}"
         href="${escapeAttr(profileUrl)}"
         target="_blank" rel="noopener"
         title="${escapeAttr(verified ? 'Open verified LinkedIn profile' : 'Search LinkedIn for ' + member.name + ' at ' + c.name)}">
        <div class="team-avatar" style="background:hsl(${hue}, 50%, 30%); color:hsl(${hue}, 90%, 88%)">${escapeHtml(initials)}</div>
        <div class="team-info">
          <div class="team-name">${escapeHtml(member.name)}</div>
          ${member.title ? `<div class="team-title">${escapeHtml(member.title)}</div>` : ''}
          ${bioHTML}
          ${emailHTML}
          ${linkLabel}
        </div>
      </a>`;
  }

  function renderTeamEmptyActions(c) {
    const coPeople = linkedinCompanyPeopleUrl(c);
    const peopleSearch = linkedinPeopleSearchUrl(c);
    return `
      <div class="team-empty-actions">
        <button class="mini-btn" onclick="App.discoverPeople('${escapeAttr(c.id)}')">🔍 Find people on LinkedIn</button>
        ${coPeople
          ? `<a class="mini-btn mini-btn-link" href="${escapeAttr(coPeople)}" target="_blank" rel="noopener">👥 All employees on LinkedIn ↗</a>`
          : `<a class="mini-btn mini-btn-link" href="${escapeAttr(peopleSearch)}" target="_blank" rel="noopener">👥 Search people on LinkedIn ↗</a>`}
      </div>`;
  }

  function renderTeamSection(c) {
    const team = c.team || [];
    const verifiedCount = team.filter(isVerifiedLinkedIn).length;
    const unverifiedCount = team.length - verifiedCount;

    if (!team.length) {
      if (_enriching.has(String(c.id)) && c.enrich_depth !== 'full') {
        return `<div class="detail-section">
          <div class="detail-label">People at ${escapeHtml(c.name)}</div>
          <div class="empty-hint">⏳ Deep-scanning website &amp; LinkedIn for team members…</div>
        </div>`;
      }
      if (!c.enriched_at) {
        return `<div class="detail-section">
          <div class="detail-label">People at ${escapeHtml(c.name)}</div>
          <div class="empty-hint">⏳ Scanning website &amp; LinkedIn for team members…</div>
        </div>`;
      }
      return `<div class="detail-section">
        <div class="detail-label">People at ${escapeHtml(c.name)}</div>
        <div class="empty-hint">No team page on their website. Use LinkedIn search below — we only show direct profile links when verified.</div>
        ${renderTeamEmptyActions(c)}
      </div>`;
    }

    const coPeople = linkedinCompanyPeopleUrl(c);
    const note = verifiedCount
      ? `<div class="section-note">${verifiedCount} verified LinkedIn profile${verifiedCount !== 1 ? 's' : ''}${unverifiedCount ? ` · ${unverifiedCount} others open LinkedIn search (not guessed)` : ''}</div>`
      : `<div class="section-note">Team from their website — no verified LinkedIn URLs yet. Click each person to search LinkedIn safely.</div>`;

    return `
      <div class="detail-section">
        <div class="detail-label">
          <span>People at ${escapeHtml(c.name)} (${team.length})</span>
          <button class="link-btn-small" onclick="App.discoverPeople('${escapeAttr(c.id)}')">↻ Re-verify LinkedIn</button>
        </div>
        ${note}
        <div class="team-grid" id="teamGrid-${escapeAttr(c.id)}">
          ${team.map(m => renderTeamCard(c, m)).join('')}
        </div>
        ${coPeople ? `<a class="team-all-li" href="${escapeAttr(coPeople)}" target="_blank" rel="noopener">Browse all employees on LinkedIn company page ↗</a>` : ''}
      </div>`;
  }

  function renderJobsSection(c) {
    const jobs = c.jobs || [];
    const jobsHTML = jobs.length
      ? jobs.map(renderJobRow).join('')
      : `<div class="empty-hint">${c.careers_url
          ? `No open roles detected automatically. <a href="${escapeAttr(c.careers_url)}" target="_blank" rel="noopener">Open careers page ↗</a> or try ↻ Scan jobs (includes Seek, Indeed, LinkedIn).`
          : c.enriched_at
            ? (state.hasSerperKey
              ? 'No roles on their website or major job boards (Seek, Indeed, LinkedIn Jobs, Jora). Try ↻ Scan jobs or email them directly.'
              : 'No careers page found. Add SERPER_API_KEY in .env to search Seek, Indeed &amp; LinkedIn Jobs globally.')
            : '⏳ Checking website careers page and job boards…'}</div>`;
    return `
      <div class="detail-section jobs-section">
        <div class="detail-label">
          <span>Careers &amp; open roles (${jobs.length})</span>
          <button class="mini-btn" onclick="App.refreshJobs('${c.id}')">↻ Scan jobs</button>
        </div>
        ${jobsHTML}
      </div>`;
  }

  function stringHue(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  // Friendly placeholder shown immediately when the user clicks an un-enriched
  // company — gives feedback while the deep crawl runs (5–10s typically).
  function renderDeepScanSkeleton(c) {
    const host = hostnameOf(c.website);
    return `
      <div class="deep-scan">
        <div class="deep-scan-spinner"></div>
        <div class="deep-scan-title">Deep-scanning <strong>${escapeHtml(host)}</strong></div>
        <div class="deep-scan-sub">Website careers · ATS APIs · Seek · Indeed · LinkedIn Jobs · team &amp; contact…</div>
        <ul class="deep-scan-tasks">
          <li><span class="ds-dot"></span> Extracting careers email &amp; contact details</li>
          <li><span class="ds-dot"></span> Finding team members &amp; LinkedIn profiles</li>
          <li><span class="ds-dot"></span> Looking up social profiles</li>
          <li><span class="ds-dot"></span> Scanning website + job boards for open roles</li>
        </ul>
        <a class="deep-scan-link" href="${escapeAttr(c.website)}" target="_blank" rel="noopener">Open website in new tab →</a>
      </div>
    `;
  }

  const _discovering = new Set();
  async function discoverPeople(companyId, { quiet = false } = {}) {
    if (_discovering.has(companyId)) return;
    _discovering.add(companyId);
    try {
      if (!quiet) toast('Re-verifying LinkedIn profiles…', 'info');
      const resp = await fetch(`/api/companies/${encodeURIComponent(companyId)}/discover-people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 12 }),
      });
      if (!resp.ok) throw new Error('lookup failed');
      const { team, added } = await resp.json();
      const c = state.companies.find(x => String(x.id) === String(companyId));
      if (c) c.team = team;
      if (state.selectedId === companyId && document.getElementById('detailPanel').classList.contains('open')) {
        openDetail(companyId);
      }
      if (!quiet) {
        const verified = (team || []).filter(isVerifiedLinkedIn).length;
        toast(
          verified
            ? `${verified} verified LinkedIn profile${verified !== 1 ? 's' : ''}`
            : 'No verified profiles found — use LinkedIn search links instead',
          verified ? 'success' : 'error',
        );
      }
    } catch {
      if (!quiet) toast('LinkedIn people search failed', 'error');
    } finally {
      _discovering.delete(companyId);
    }
  }

  async function resolveTeamLinkedIn(companyId, { quiet = false } = {}) {
    try {
      if (!quiet) toast('Finding LinkedIn profiles…', 'info');
      const resp = await fetch(`/api/companies/${encodeURIComponent(companyId)}/team-linkedin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyTop: 12 }),
      });
      if (!resp.ok) throw new Error('lookup failed');
      const { team } = await resp.json();
      const c = state.companies.find(x => String(x.id) === String(companyId));
      if (c) c.team = team;
      if (state.selectedId === companyId && document.getElementById('detailPanel').classList.contains('open')) {
        openDetail(companyId);
      }
      const found = (team || []).filter(isVerifiedLinkedIn).length;
      if (!quiet) toast(`${found} verified LinkedIn profile${found !== 1 ? 's' : ''}`, found ? 'success' : 'error');
    } catch (err) {
      if (!quiet) toast('LinkedIn lookup failed', 'error');
    }
  }

  // Normalise the user's skill list to lowercase keywords for matching against
  // opportunity tags. Allows fuzzy match: "Graphic design" → "graphic", "design".
  function profileSkillKeywords() {
    return (profile.skills || []).flatMap(s =>
      s.toLowerCase().replace(/[\/&]/g, ' ').split(/\s+/).filter(w => w.length > 2)
    );
  }
  function oppMatchesProfile(opportunity, userKeywords) {
    if (!userKeywords.length) return false;
    const tokens = opportunity.toLowerCase().split(/[\s/]+/).filter(t => t.length > 2);
    return userKeywords.some(k => {
      if (k.length < 3) return false;
      return tokens.some(t => t === k || t.includes(k) || k.includes(t));
    });
  }

  function hasAppliedJob(c) {
    return (c.jobs || []).some(j => j.applied);
  }

  // ---- richer job & explore rendering -------------------------------------

  function renderJobRow(j) {
    const meta = [];
    if (j.job_type)     meta.push(`<span>💼 ${escapeHtml(j.job_type)}</span>`);
    if (j.location)     meta.push(`<span>📍 ${escapeHtml(j.location)}</span>`);
    if (j.remote)       meta.push(`<span style="color:var(--accent2)">🌐 Remote</span>`);
    if (j.department)   meta.push(`<span>🏷 ${escapeHtml(j.department)}</span>`);
    if (j.salary)       meta.push(`<span>💰 ${escapeHtml(j.salary)}</span>`);
    if (j.posted_at)    meta.push(`<span title="Posted ${new Date(j.posted_at).toLocaleDateString()}">🗓 Posted ${timeAgo(j.posted_at)}</span>`);
    if (j.closes_at) {
      const days = Math.ceil((j.closes_at - Date.now()) / 86400000);
      const cls = days < 0 ? 'closed' : days <= 7 ? 'urgent' : '';
      const txt = days < 0 ? `closed ${-days}d ago` : `closes in ${days}d`;
      meta.push(`<span class="deadline ${cls}" title="Deadline ${new Date(j.closes_at).toLocaleDateString()}">⏰ ${txt}</span>`);
    }
    if (j.source)       meta.push(`<span class="job-source">${escapeHtml(j.source)}</span>`);
    const trust = jobTrustLabel(j.source, j);

    const desc = j.description
      ? `<div class="job-desc">${escapeHtml(j.description)}</div>`
      : '';

    const titleHtml = j.url
      ? `<a href="${escapeAttr(j.url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>`
      : escapeHtml(j.title);

    return `
      <div class="job-row ${j.applied ? 'applied' : ''}">
        <input type="checkbox" class="job-checkbox" ${j.applied ? 'checked' : ''} onchange="App.toggleJobApplied(${j.id}, this.checked)" />
        <div class="job-body">
          <div class="job-title">${titleHtml}</div>
          <div class="job-meta">${meta.join('')}${trust}</div>
          ${desc}
          ${j.url ? `<a class="job-apply-link" href="${escapeAttr(j.url)}" target="_blank" rel="noopener">Open posting →</a>` : ''}
        </div>
      </div>`;
  }

  function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (diff < 0) return 'soon';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + 'd ago';
    const mo = Math.floor(day / 30);
    if (mo < 12) return mo + 'mo ago';
    return Math.floor(mo / 12) + 'y ago';
  }

  // ---- outreach generator -------------------------------------------------

  // Returns an array of opportunities from `c.opportunities` ordered with the
  // user-matching ones first, capped at 3.
  function rankedOpportunities(c) {
    const opps = c.opportunities || [];
    const keys = profileSkillKeywords();
    const matches = opps.filter(o => oppMatchesProfile(o, keys));
    const rest    = opps.filter(o => !oppMatchesProfile(o, keys));
    return [...matches, ...rest].slice(0, 3);
  }

  function renderMatchBanner(c) {
    const keys = profileSkillKeywords();
    if (!keys.length) return '';
    const opps = (c.opportunities || []).filter(o => oppMatchesProfile(o, keys));
    if (opps.length === 0) return '';
    return `<div class="match-banner">🎯 <strong>Good match for your skills</strong> — likely needs ${opps.slice(0, 2).join(' / ')}.</div>`;
  }

  function buildOutreachSubject(c) {
    const opps = rankedOpportunities(c);
    const skill = profile.skills?.[0] || opps[0] || 'design';
    return `${capitalize(skill)} for ${c.name}`;
  }

  function buildOutreachBody(c) {
    const name = profile.name?.trim() || '[your name]';
    const skill = profile.skills?.[0] || '';
    const allSkills = (profile.skills || []).join(', ');
    const city = profile.city?.trim() || '';
    const portfolio = profile.portfolio?.trim() || '';
    const pitch = profile.pitch?.trim();
    const signature = profile.signature?.trim() || name;

    const opps = rankedOpportunities(c);
    const oppList = opps.length ? opps.join(' and ') : 'a few projects';

    // Observation tailored to business type
    const observation = buildObservation(c);

    const intro = pitch
      ? pitch
      : (skill
        ? `I'm ${name}, a ${skill}${city ? ` based in ${city}` : ''}${allSkills && allSkills !== skill ? ` (also: ${allSkills})` : ''}.`
        : `I'm ${name}${city ? ` based in ${city}` : ''}.`);

    const portfolioLine = portfolio ? `\nYou can see some of my recent work here: ${portfolio}\n` : '';

    return [
      `Hi ${greetingName(c)},`,
      '',
      intro,
      '',
      `I came across ${c.name} ${c.address ? `(${shortAddr(c.address)})` : ''} and ${observation}`,
      '',
      `If you've been thinking about ${oppList}, I'd love to chat — even 15 minutes would be useful for me to understand what you have in mind, and you'd get some honest thoughts back.`,
      portfolioLine,
      `Either way, congrats on what you're building.`,
      '',
      `Best,`,
      signature,
    ].join('\n');
  }

  function greetingName(c) {
    // "Hi [Company] team" reads better than "Hi The Coffee Shop,"
    return `${c.name} team`;
  }

  function shortAddr(a) {
    // Strip country/postcode noise — keep first 2 comma segments.
    return a.split(',').slice(0, 2).join(',').trim();
  }

  function buildObservation(c) {
    const type = (c.type || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const hay = `${name} ${type}`;
    if (/restaurant|cafe|bakery|coffee|bar|pub|food|takeaway/.test(hay))
      return `loved the look of the place. A lot of hospitality spots I work with end up wanting to refresh their menus, signage or social posts going into a new season.`;
    if (/hotel|motel|lodging|resort|hostel/.test(hay))
      return `it stood out as a place where great photography and a tighter web experience could really sell the rooms.`;
    if (/store|shop|boutique|fashion|clothing|jewel|cosmetic|florist|gift/.test(hay))
      return `it's the kind of business where strong product photography and a clean ecommerce experience often pay back fast.`;
    if (/real\s*estate|property|realtor/.test(hay))
      return `most of the agencies I speak to are competing on the quality of their listing photos and how easy their site is to browse.`;
    if (/dentist|dental|clinic|doctor|medical|physio|chiropract|optomet|veterin/.test(hay))
      return `practices like yours often benefit from a website that makes booking obvious and builds trust quickly.`;
    if (/lawyer|legal|attorney|solicitor|barrister/.test(hay))
      return `a lot of legal practices I've worked with quietly need a website refresh and clearer service pages.`;
    if (/accountant|bookkeep|tax|financial|insurance/.test(hay))
      return `professional service firms often see real lift from a cleaner site and clearer service pages.`;
    if (/architect|interior|builder|construct|landscap/.test(hay))
      return `studios like yours live and die on portfolio presentation — a tight site and great photography go a long way.`;
    if (/school|college|tutor|educat|childcare|kindergarten/.test(hay))
      return `education brands often benefit from warmer illustration, a friendlier site, and short video.`;
    if (/gym|fitness|yoga|pilates|crossfit/.test(hay))
      return `boutique fitness brands usually do really well with strong visual identity and short social-ready video.`;
    if (/spa|salon|beauty|barber|hair|nail/.test(hay))
      return `the spaces in this category usually benefit a lot from consistent brand photography and a simple booking-first site.`;
    if (/car|auto|motor|garage|tyre/.test(hay))
      return `auto businesses often have ageing websites that don't reflect the quality of the work — that's almost always low-hanging fruit.`;
    return `thought my skills might be useful as you grow.`;
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function renderOutreach(c) {
    const hasProfile = profile.name || profile.skills?.length;
    if (!hasProfile) {
      return `<div class="outreach-no-profile">
        Set your profile to generate a personalised cold-email template for every company.
        <br><button class="btn btn-primary" onclick="App.openProfile()">👤 Set profile</button>
      </div>`;
    }

    const cid = escapeAttr(c.id);
    const verified = isVerifiedEmail(c);
    const hasEmail = !!c.email;
    const subject = buildOutreachSubject(c);
    const body = buildOutreachBody(c);
    const variants = _outreachVariants[c.id] || [];

    let toLine;
    if (verified && c.email) {
      toLine = `<span class="email-ok">✓ ${escapeHtml(c.email)}</span>`;
    } else if (c.email) {
      toLine = `${escapeHtml(c.email)} <span class="email-warn">(not verified)</span>`;
    } else {
      toLine = '<span class="email-warn">No email found — enrich website first</span>';
    }

    const verifyBtn = hasEmail
      ? `<button type="button" class="mini-btn" id="verifyEmailBtn-${cid}" onclick="App.verifyCompanyEmail('${cid}')">${verified ? '↻ Re-verify email' : '🔍 Verify email'}</button>`
      : '';

    const variantCards = variants.length
      ? variants.map((v, i) => `
          <button type="button" class="outreach-variant" onclick="App.applyOutreachVariant('${cid}', ${i})">
            <span class="ov-label">${escapeHtml(v.label || v.tone)}</span>
            <span class="ov-hint">${escapeHtml(v.hint || v.source || '')}</span>
            <span class="ov-subj">${escapeHtml(v.subject || '')}</span>
          </button>`).join('')
      : '';

    const canSend = verified && hasEmail && profile.senderEmail && state.hasSmtp;
    const sendHint = !state.hasSmtp
      ? 'Add SMTP_HOST, SMTP_USER, SMTP_PASS to .env to enable direct send'
      : !profile.senderEmail
        ? 'Add your email in Profile to send'
        : !verified
          ? 'Verify their email before sending'
          : '';

    return `
      <div class="outreach-section" id="outreachSection-${cid}">
        <div class="outreach-top">
          <div class="outreach-subject">To: <strong>${toLine}</strong></div>
          ${verifyBtn}
        </div>
        <div class="outreach-verify-note" id="outreachVerifyNote-${cid}"></div>

        <div class="outreach-ai-bar">
          <span class="outreach-ai-title">✨ Quick creative drafts</span>
          <button type="button" class="mini-btn" id="genEmailBtn-${cid}" onclick="App.generateOutreachEmails('${cid}')">
            ${state.hasOpenAiKey ? 'Generate with AI' : 'Generate options'}
          </button>
        </div>
        <div class="outreach-variants" id="outreachVariants-${cid}">${variantCards}</div>

        <label class="outreach-field-label">Subject</label>
        <input type="text" class="outreach-subject-input" id="outreachSubject-${cid}" value="${escapeAttr(subject)}" />

        <label class="outreach-field-label">Message</label>
        <textarea class="outreach-body" id="outreachBody-${cid}">${escapeHtml(body)}</textarea>

        <div class="outreach-actions">
          <button type="button" class="btn btn-primary" onclick="App.copyOutreach('${cid}')">📋 Copy</button>
          <button type="button" class="btn btn-accent-send" id="sendEmailBtn-${cid}"
            onclick="App.sendOutreachEmail('${cid}')"
            ${canSend ? '' : `disabled title="${escapeAttr(sendHint)}"`}>
            ✉ Send email
          </button>
          ${verified && c.email
            ? `<a class="btn btn-outline" href="mailto:${escapeAttr(c.email)}?subject=${encodeURIComponent(subject)}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">↗ Mail app</a>`
            : ''}
        </div>
        ${sendHint && !canSend ? `<div class="outreach-send-hint">${escapeHtml(sendHint)}</div>` : ''}
      </div>`;
  }

  function getOutreachFields(id) {
    return {
      subject: document.getElementById('outreachSubject-' + id)?.value?.trim() || '',
      body: document.getElementById('outreachBody-' + id)?.value?.trim() || '',
    };
  }

  function mergeCompanyUpdate(updated) {
    if (!updated?.id) return;
    const inScan = state.companies.find(x => String(x.id) === String(updated.id));
    if (inScan) Object.assign(inScan, updated);
    const inPipe = state.pipelineCompanies.find(x => String(x.id) === String(updated.id));
    if (inPipe) Object.assign(inPipe, updated);
  }

  async function verifyCompanyEmail(id) {
    const btn = document.getElementById('verifyEmailBtn-' + id);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Verifying…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/verify-email`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Verification failed');
      if (data.company) mergeCompanyUpdate(data.company);
      const note = document.getElementById('outreachVerifyNote-' + id);
      if (note) {
        note.className = 'outreach-verify-note ' + (data.verified ? 'ok' : 'warn');
        note.textContent = data.message || (data.verified ? 'Verified' : 'Not verified');
      }
      toast(data.message || (data.verified ? 'Email verified' : 'Could not verify'), data.verified ? 'success' : 'error');
      if (state.selectedId === id) openDetail(id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) {
        const c = state.companies.find(x => String(x.id) === String(id))
          || state.pipelineCompanies.find(x => String(x.id) === String(id));
        btn.disabled = false;
        btn.textContent = isVerifiedEmail(c || {}) ? '↻ Re-verify email' : '🔍 Verify email';
      }
    }
  }

  async function generateOutreachEmails(id) {
    const btn = document.getElementById('genEmailBtn-' + id);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/generate-emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, count: 4 }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Generation failed');
      _outreachVariants[id] = data.variants || [];
      const wrap = document.getElementById('outreachVariants-' + id);
      if (wrap) {
        wrap.innerHTML = _outreachVariants[id].map((v, i) => `
          <button type="button" class="outreach-variant" onclick="App.applyOutreachVariant('${escapeAttr(id)}', ${i})">
            <span class="ov-label">${escapeHtml(v.label || v.tone)}</span>
            <span class="ov-hint">${escapeHtml(v.hint || (data.ai ? 'AI' : 'Template'))}</span>
            <span class="ov-subj">${escapeHtml(v.subject || '')}</span>
          </button>`).join('');
      }
      toast(
        data.ai ? 'AI drafts ready — pick one below' : 'Draft options ready — pick one below',
        'success',
      );
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = state.hasOpenAiKey ? 'Generate with AI' : 'Generate options';
      }
    }
  }

  function applyOutreachVariant(id, index) {
    const v = (_outreachVariants[id] || [])[index];
    if (!v) return;
    const subj = document.getElementById('outreachSubject-' + id);
    const body = document.getElementById('outreachBody-' + id);
    if (subj) subj.value = v.subject || '';
    if (body) body.value = v.body || '';
    document.querySelectorAll(`#outreachVariants-${CSS.escape(id)} .outreach-variant`).forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
    toast(`Applied “${v.label || v.tone}” draft`, 'success');
  }

  async function sendOutreachEmail(id) {
    const c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    if (!c) return;
    if (!isVerifiedEmail(c)) {
      toast('Verify their email first', 'error');
      return;
    }
    if (!profile.senderEmail) {
      toast('Add your email in Profile → Your email (for sending)', 'error');
      openProfile();
      return;
    }
    const { subject, body } = getOutreachFields(id);
    if (!subject || !body) {
      toast('Subject and message required', 'error');
      return;
    }
    if (!window.confirm(`Send email to ${c.email}?\n\nSubject: ${subject}`)) return;

    const btn = document.getElementById('sendEmailBtn-' + id);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          body,
          fromName: profile.name || profile.signature,
          fromEmail: profile.senderEmail,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Send failed');
      toast(`Email sent to ${data.to}`, 'success');
      await toggleStatus(id, 'applied');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = !(isVerifiedEmail(c) && profile.senderEmail && state.hasSmtp);
        btn.textContent = '✉ Send email';
      }
    }
  }

  function copyOutreach(id) {
    const { subject, body } = getOutreachFields(id);
    const text = `Subject: ${subject}\n\n${body}`;
    navigator.clipboard.writeText(text).then(
      () => toast('Email copied', 'success'),
      () => toast('Copy failed', 'error'),
    );
  }

  function renderExplore(c) {
    const links = [];
    const nameQ = encodeURIComponent(c.name);
    const addrQ = encodeURIComponent([c.name, c.address].filter(Boolean).join(' '));
    links.push({ icon: '🗺', label: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${addrQ}` });
    links.push({ icon: '🚗', label: 'Directions',  url: `https://www.google.com/maps/dir/?api=1&destination=${addrQ}` });
    const coLi = (c.socials || {}).linkedin;
    if (coLi) {
      links.push({ icon: '💼', label: 'LinkedIn co.', url: coLi });
      const coPeople = linkedinCompanyPeopleUrl(c);
      if (coPeople) links.push({ icon: '👥', label: 'Employees', url: coPeople });
    } else {
      links.push({ icon: '💼', label: 'LinkedIn', url: `https://www.linkedin.com/search/results/companies/?keywords=${nameQ}` });
      links.push({ icon: '👥', label: 'People', url: linkedinPeopleSearchUrl(c) });
    }
    links.push({ icon: '🔎', label: 'Google', url: `https://www.google.com/search?q=${nameQ}+careers` });
    if (c.email && isVerifiedEmail(c)) {
      const subj = encodeURIComponent(`Application — ${c.name}`);
      links.push({ icon: '✉', label: 'Email careers', url: `mailto:${c.email}?subject=${subj}` });
    }

    const stats = [];
    if (typeof c.rating === 'number')       stats.push(`<span>⭐ ${c.rating.toFixed(1)} (Google)</span>`);
    if (c.address)                          stats.push(`<span>📌 ${escapeHtml(c.address)}</span>`);
    if (c.enriched_at) {
      stats.push(`<span title="${new Date(c.enriched_at).toLocaleString()}">🕒 Enriched ${timeAgo(c.enriched_at)}</span>`);
    } else if (c.website) {
      stats.push(`<span style="color:var(--accent2)">⏳ Fetching website &amp; jobs… (≈10s)</span>`);
    }
    const totalJobs   = (c.jobs || []).length;
    const appliedJobs = (c.jobs || []).filter(j => j.applied).length;
    if (totalJobs)                          stats.push(`<span>📋 ${appliedJobs}/${totalJobs} jobs applied</span>`);

    return `
      <div class="explore-stats">${stats.join('')}</div>
      <div class="explore-links">
        ${links.map(l => `<a class="explore-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${l.icon} ${escapeHtml(l.label)}</a>`).join('')}
      </div>`;
  }

  // ---- detail panel -------------------------------------------------------

  async function openDetail(id) {
    let c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    if (!c) {
      try {
        c = await fetch(`/api/companies/${encodeURIComponent(id)}`).then(r => {
          if (!r.ok) throw new Error('not found');
          return r.json();
        });
      } catch {
        return;
      }
    }
    // Guard rails: bail unless we have a real company with a real name. This
    // prevents the panel from ever opening with the empty placeholder header.
    if (!c || !c.name || typeof c.name !== 'string' || !c.name.trim()) {
      return;
    }
    state.selectedId = id;
    document.getElementById('detailName').textContent = c.name;
    document.getElementById('detailType').textContent = c.type || 'Business';

    // If this card hasn't been enriched yet, show a friendly "deep-scanning"
    // skeleton FIRST so the panel never appears empty. lazyEnrich() will
    // re-call openDetail() once data arrives.
    const isEnriched = !!c.enriched_at;
    const hasAnyData = !!(c.email || c.phone || c.description || c.careers_url ||
                          (c.team && c.team.length) ||
                          (c.socials && Object.keys(c.socials).length) ||
                          (c.jobs && c.jobs.length));
    if (!isEnriched && !hasAnyData && c.website) {
      document.getElementById('detailBody').innerHTML = renderDeepScanSkeleton(c);
      document.getElementById('detailPanel').classList.add('open');
      document.getElementById('detailBackdrop').classList.add('show');
      renderCompanies();
      lazyEnrich(c.id, { depth: 'full' });
      return;
    }

    const websiteRow = c.website
      ? `<div class="contact-row"><span class="contact-icon">🌐</span><a href="${escapeAttr(c.website)}" target="_blank" rel="noopener">${escapeHtml(hostnameOf(c.website))}</a></div>`
      : `<div class="contact-row missing"><span class="contact-icon">🌐</span>No website found</div>`;

    const emailRow = c.email
      ? (isVerifiedEmail(c)
        ? `<div class="contact-row"><span class="contact-icon">✉</span><a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a><button class="copy-btn" onclick="App.copy('${escapeAttr(c.email)}')">Copy</button></div><div class="trust-note">${escapeHtml(emailTrustNote(c))}</div>`
        : `<div class="contact-row unverified"><span class="contact-icon">✉</span><span>${escapeHtml(c.email)}</span><button class="copy-btn" onclick="App.copy('${escapeAttr(c.email)}')">Copy</button></div><div class="trust-note warn">${escapeHtml(emailTrustNote(c))}</div>`)
      : `<div class="contact-row missing"><span class="contact-icon">✉</span>No careers email found on their website</div>`;

    const phoneRow = c.phone
      ? `<div class="contact-row"><span class="contact-icon">📞</span><a href="tel:${escapeAttr(c.phone)}">${escapeHtml(c.phone)}</a><button class="copy-btn" onclick="App.copy('${escapeAttr(c.phone)}')">Copy</button></div>`
      : '';

    const careersRow = c.careers_url
      ? `<div class="contact-row"><span class="contact-icon">💼</span><a href="${escapeAttr(c.careers_url)}" target="_blank" rel="noopener">Careers page →</a></div>`
      : `<div class="contact-row missing"><span class="contact-icon">💼</span>No careers page found</div>`;

    const addressBit = c.address ? `<div class="contact-row"><span class="contact-icon">📌</span>${escapeHtml(c.address)}</div>` : '';

    const trustBanner = buildTrustBanner(c);

    const otherEmails = (c.all_emails || []).filter(e => isPlausibleExtraEmail(e, c));
    const otherEmailsRow = otherEmails.length ? `
      <div class="detail-section">
        <div class="detail-label">Other emails found</div>
        ${otherEmails.slice(0, 8).map(e => `
          <div class="contact-row">
            <span class="contact-icon">✉</span>
            <a href="mailto:${escapeAttr(e)}">${escapeHtml(e)}</a>
            <button class="copy-btn" onclick="App.copy('${escapeAttr(e)}')">Copy</button>
          </div>`).join('')}
      </div>` : '';

    // Social profiles
    const socials = c.socials || {};
    const socialChips = Object.entries(socials).map(([k, url]) => {
      const icon = { linkedin: '💼', instagram: '📷', facebook: '👍', twitter: '𝕏', youtube: '▶', tiktok: '🎵' }[k] || '🔗';
      return `<a class="social-chip" href="${escapeAttr(url)}" target="_blank" rel="noopener">${icon} ${escapeHtml(k.charAt(0).toUpperCase() + k.slice(1))}</a>`;
    }).join('');
    const socialRow = socialChips ? `
      <div class="detail-section">
        <div class="detail-label">Social profiles</div>
        <div class="socials-row">${socialChips}</div>
      </div>` : '';

    // Description (from meta description / og:description / page text)
    const descSection = c.description ? `
      <div class="detail-section">
        <div class="detail-label">About</div>
        <div class="about-text">${escapeHtml(c.description)}</div>
      </div>` : '';

    // Team section: names + titles + LinkedIn links (resolved or searchable).
    const teamSection = renderTeamSection(c);
    const jobsSection = renderJobsSection(c);

    const stars = [1, 2, 3, 4, 5].map(i => `<span class="star ${c.user_rating >= i ? 'lit' : ''}" onclick="App.setRating('${c.id}', ${i})">★</span>`).join('');

    document.getElementById('detailBody').innerHTML = `
      ${trustBanner}
      ${renderMatchBanner(c)}
      ${descSection}
      <div class="detail-section">
        <div class="detail-label">
          <span>Contact &amp; Links</span>
          ${c.website ? `<button class="mini-btn" onclick="App.reVerifyCompany('${escapeAttr(c.id)}')">↻ Re-scan website</button>` : ''}
        </div>
        ${websiteRow}
        ${emailRow}
        ${phoneRow}
        ${careersRow}
        ${addressBit}
      </div>
      ${teamSection}
      ${jobsSection}
      ${socialRow}
      ${otherEmailsRow}
      <div class="detail-section">
        <div class="detail-label">Outreach email</div>
        ${renderOutreach(c)}
      </div>
      <div class="detail-section">
        <div class="detail-label">Explore</div>
        ${renderExplore(c)}
      </div>
      <div class="detail-section">
        <div class="detail-label">Application status</div>
        <button class="apply-big ${c.status === 'applied' ? 'applied' : ''}" onclick="App.toggleStatus('${c.id}', 'applied')">
          ${c.status === 'applied' ? '✓ Applied — click to undo' : 'Mark whole company as applied (manual)'}
        </button>
      </div>
      <div class="detail-section">
        <div class="detail-label">Your rating</div>
        <div class="rating-row">${stars}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Notes</div>
        <textarea class="notes-area" placeholder="Add notes about this company…" oninput="App.saveNotes('${c.id}', this.value)">${escapeHtml(c.notes || '')}</textarea>
      </div>
    `;
    document.getElementById('detailPanel').classList.add('open');
    document.getElementById('detailBackdrop').classList.add('show');
    renderCompanies();
    addMarkers();
    if (c.lat && c.lng) {
      state.map.panTo([c.lat, c.lng], { animate: true, duration: 0.4 });
    }

    // Lazy enrichment: full scan when user opens a company (team, jobs, LinkedIn).
    if (c.website) {
      if (!c.enriched_at) {
        lazyEnrich(c.id, { depth: 'full' });
      } else if (c.enrich_depth !== 'full') {
        lazyEnrich(c.id, { depth: 'full' });
      }
    }
  }

  async function reVerifyCompany(id) {
    const c = state.companies.find(x => String(x.id) === String(id));
    if (!c || !c.website) return;
    c.enrich_error = null;
    document.getElementById('detailBody').innerHTML = renderDeepScanSkeleton(c);
    await lazyEnrich(id, { force: true, depth: 'full' });
  }

  async function lazyEnrich(id, opts = {}) {
    const sid = String(id);
    const c0 = state.companies.find(x => String(x.id) === sid);
    const depth = opts.depth || 'contact';
    if (!opts.force) {
      if (depth === 'contact' && c0?.enriched_at) return;
      if (depth === 'full' && c0?.enrich_depth === 'full') return;
    }
    if (_enriching.has(sid)) return;
    _enriching.add(sid);
    renderCompanies();
    try {
      const resp = await fetch(
        `/api/companies/${encodeURIComponent(id)}/enrich?depth=${encodeURIComponent(depth)}`,
        { method: 'POST' },
      );
      if (!resp.ok) {
        const c = state.companies.find(x => String(x.id) === String(id));
        if (c) { c.enrich_error = 'Could not reach website'; }
        if (state.selectedId === id &&
            document.getElementById('detailPanel').classList.contains('open')) {
          openDetail(id);
        }
        return;
      }
      const updated = await resp.json();
      const c = state.companies.find(x => String(x.id) === String(id));
      if (c) Object.assign(c, updated);
      if (state.selectedId === id &&
          document.getElementById('detailPanel').classList.contains('open')) {
        openDetail(id);
      }
      renderCompanies();
    } catch {
      const c = state.companies.find(x => String(x.id) === String(id));
      if (c) { c.enrich_error = 'Enrichment failed'; }
      if (state.selectedId === id &&
          document.getElementById('detailPanel').classList.contains('open')) {
        openDetail(id);
      }
    } finally {
      _enriching.delete(sid);
      renderCompanies();
    }
  }

  // After a scan, queue a fast contact-only pass for every company (email, phone,
  // description). Full team/job/LinkedIn scan runs when the user opens a card.
  let _bgController = null;
  function backgroundEnrichAll() {
    if (_bgController) _bgController.cancel = true;
    const ctrl = { cancel: false };
    _bgController = ctrl;

    let queue = state.companies.filter(c => !c.enriched_at && c.website);
    const limit = state.enrichLimit || 0;
    if (limit > 0 && queue.length > limit) queue = queue.slice(0, limit);
    if (queue.length === 0) { setEnrichProgress(null); return; }
    const total = queue.length;
    let done = 0;
    let failed = 0;
    let active = 0;
    const CONCURRENCY = state.enrichConcurrency || 6;
    setEnrichProgress({ done, total, mode: 'contact' });

    function next() {
      if (ctrl.cancel) return;
      if (queue.length === 0 && active === 0) {
        setEnrichProgress(null);
        if (failed === 0) toast('Contact info loaded for all businesses', 'success');
        else toast(`Loaded ${done - failed}/${total} (${failed} unreachable)`, failed === total ? 'error' : 'success');
        return;
      }
      while (active < CONCURRENCY && queue.length > 0) {
        const c = queue.shift();
        const sid = String(c.id);
        if (_enriching.has(sid)) { done++; next(); continue; }
        _enriching.add(sid);
        active++;
        fetch(`/api/companies/${encodeURIComponent(c.id)}/enrich?depth=contact`, { method: 'POST' })
          .then(r => r.ok ? r.json() : Promise.reject(new Error('enrich failed')))
          .then(updated => {
            if (updated?.enrich_failed) throw new Error('fetch failed');
            const cur = state.companies.find(x => String(x.id) === sid);
            if (cur) Object.assign(cur, updated);
            if (String(state.selectedId) === sid &&
                document.getElementById('detailPanel').classList.contains('open')) {
              openDetail(c.id);
            }
          })
          .catch(() => { failed++; })
          .finally(() => {
            _enriching.delete(sid);
            active--;
            done++;
            if (!ctrl.cancel) {
              setEnrichProgress({ done, total });
              if (done % 2 === 0 || done === total) renderCompanies();
              next();
            }
          });
      }
    }
    next();
  }

  function setEnrichProgress(p) {
    const el = document.getElementById('enrichProgress');
    if (!el) return;
    if (!p) { el.style.display = 'none'; return; }
    const pct = Math.round((p.done / p.total) * 100);
    el.style.display = '';
    el.innerHTML = `<span class="ep-text">Contact scan <strong>${p.done}/${p.total}</strong></span><span class="ep-fill" style="width:${pct}%"></span>`;
  }

  function closeDetail() {
    document.getElementById('detailPanel').classList.remove('open');
    document.getElementById('detailBackdrop').classList.remove('show');
    document.getElementById('detailName').textContent = '';
    document.getElementById('detailType').textContent = '';
    document.getElementById('detailBody').innerHTML = '';
    state.selectedId = null;
    renderCompanies(true);
    if (state.companies.length) addMarkers();
  }

  // ---- mutations (persisted via API) --------------------------------------

  async function toggleStatus(id, status) {
    let c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    if (!c) return;
    const next = c.status === status ? 'none' : status;
    try {
      const updated = await patchCompany(id, { status: next });
      Object.assign(c, updated);
      const inScan = state.companies.find(x => String(x.id) === String(id));
      if (inScan) Object.assign(inScan, updated);
      renderCompanies(true);
      addMarkers();
      refreshPipelineCounts();
      if (state.view === 'pipeline') {
        await loadPipelineList(state.pipelineTab === 'interested' ? 'interested' : 'applied');
      }
      if (state.selectedId === id) openDetail(id);
    } catch (err) {
      toast('Could not save: ' + err.message, 'error');
    }
  }

  async function setRating(id, stars) {
    const c = state.companies.find(x => String(x.id) === String(id));
    if (!c) return;
    try {
      const updated = await patchCompany(id, { user_rating: stars });
      Object.assign(c, updated);
      openDetail(id);
    } catch (err) {
      toast('Could not save rating: ' + err.message, 'error');
    }
  }

  let notesTimer = null;
  function saveNotes(id, val) {
    const c = state.companies.find(x => String(x.id) === String(id));
    if (c) c.notes = val;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      try { await patchCompany(id, { notes: val }); }
      catch (err) { toast('Notes not saved: ' + err.message, 'error'); }
    }, 500);
  }

  async function toggleJobApplied(jobId, applied) {
    try {
      const updated = await patchJob(jobId, { applied });
      for (const c of [...state.companies, ...state.pipelineCompanies]) {
        const j = (c.jobs || []).find(x => x.id === jobId);
        if (j) Object.assign(j, updated);
      }
      renderCompanies(true);
      addMarkers();
      refreshPipelineCounts();
      if (state.view === 'pipeline') {
        await loadPipelineList(state.pipelineTab === 'interested' ? 'interested' : 'applied');
      }
      if (state.selectedId) openDetail(state.selectedId);
    } catch (err) {
      toast('Could not save: ' + err.message, 'error');
    }
  }

  async function refreshJobs(id) {
    toast('Refreshing jobs…');
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/refresh-jobs`, { method: 'POST' });
      if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
      const data = await resp.json();
      const c = state.companies.find(x => String(x.id) === String(id));
      if (c) c.jobs = data.jobs;
      openDetail(id);
      toast(`Pulled ${data.fetched} job(s)${data.sources?.length ? ' · ' + data.sources.join(', ') : ''}`, 'success');
    } catch (err) {
      toast('Refresh failed: ' + err.message, 'error');
    }
  }

  async function patchCompany(id, body) {
    const resp = await fetch(`/api/companies/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    return resp.json();
  }

  async function patchJob(id, body) {
    const resp = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    return resp.json();
  }

  // ---- filters / tabs -----------------------------------------------------

  function renderIndustryFilters() {
    const el = document.getElementById('industryFilters');
    if (!el || typeof AreaHuntIndustries === 'undefined') return;
    el.innerHTML = AreaHuntIndustries.OPTIONS.map(o => {
      const active = state.activeCats.includes(o.id);
      const label = o.id === 'all' ? 'All' : `${o.emoji} ${o.label}`;
      return `<button type="button" class="filter-tag ${active ? 'active' : ''}" data-cat="${o.id}">${label}</button>`;
    }).join('');
    el.querySelectorAll('.filter-tag').forEach(btn => {
      btn.onclick = () => toggleIndustryFilter(btn.dataset.cat);
    });
  }

  function toggleIndustryFilter(cat) {
    if (!cat) return;
    if (cat === 'all') {
      state.activeCats = ['all'];
    } else {
      let cats = state.activeCats.filter(c => c !== 'all');
      if (cats.includes(cat)) {
        cats = cats.filter(c => c !== cat);
      } else {
        cats.push(cat);
      }
      state.activeCats = cats.length ? cats : ['all'];
    }
    state.activeCat = state.activeCats[0] || 'all';
    renderIndustryFilters();
    renderCompanies(true);
    addMarkers();
    if (AuthGate.isLoggedIn?.()) {
      AuthGate.saveProfileToServer({ jobSectors: state.activeCats }).catch(() => {});
    }
  }

  function filterCat(cat) {
    toggleIndustryFilter(cat);
  }

  function setView(view, { silent = false } = {}) {
    state.view = view;
    document.body.classList.toggle('view-scan', view === 'scan');
    document.body.classList.toggle('view-pipeline', view === 'pipeline');
    document.getElementById('scanView')?.classList.toggle('hidden', view !== 'scan');
    document.getElementById('pipelinePage')?.classList.toggle('hidden', view !== 'pipeline');
    document.getElementById('navScan')?.classList.toggle('active', view === 'scan');
    document.getElementById('navPipeline')?.classList.toggle('active', view === 'pipeline');
    const scanOnly = view === 'scan';
    ['drawBtn', 'scanBtn', 'statsPill'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = scanOnly ? '' : 'none';
    });
    if (view === 'scan' && !silent) {
      renderCompanies(true);
      if (state.companies.length) addMarkers();
      if (state.map) setTimeout(() => state.map.invalidateSize(), 80);
    }
    if (view === 'pipeline' && !silent) {
      closeDetail();
      switchPipelineTab(state.pipelineTab, { silent: true });
    }
  }

  function openScanPage() {
    setView('scan');
  }

  function openPipelinePage(tab = 'interested') {
    state.pipelineTab = tab;
    setView('pipeline');
    switchPipelineTab(tab);
  }

  function switchPipelineTab(tab, { silent = false } = {}) {
    state.pipelineTab = tab;
    document.getElementById('pipeTabSaved')?.classList.toggle('active', tab === 'interested');
    document.getElementById('pipeTabApplied')?.classList.toggle('active', tab === 'applied');
    if (!silent) loadPipelineList(tab === 'interested' ? 'interested' : 'applied');
  }

  function updateStats() {
    document.getElementById('totalCount').textContent = state.companies.length;
    refreshPipelineCounts();
  }

  function clearAll() {
    if (_bgController) _bgController.cancel = true;
    setEnrichProgress(null);
    clearSessionScan();
    state.drawLayer.clearLayers();
    if (state.clusterLayer) state.clusterLayer.clearLayers();
    state.markers = [];
    state.companies = [];
    state.selBounds = null;
    updateAreaActions();
    renderCompanies(true);
    updateStats();
    closeDetail();
    document.getElementById('scanBtn').style.display = 'none';
    document.getElementById('mapHint').innerHTML = '<strong>Draw mode off</strong> — click "Draw area" then drag on the map';
  }

  // ---- misc ---------------------------------------------------------------

  async function geocodeSearch() {
    const q = document.getElementById('searchInput').value.trim();
    if (!q) return;
    try {
      const d = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`).then(r => r.json());
      if (d && d.length) state.map.setView([parseFloat(d[0].lat), parseFloat(d[0].lon)], 16);
      else toast('No results for that search', 'error');
    } catch {
      toast('Search failed', 'error');
    }
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => toast('Copied', 'success'),
      () => toast('Copy failed', 'error')
    );
  }

  function toast(msg, kind = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toast._tmr);
    toast._tmr = setTimeout(() => t.className = 'toast', 2500);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  return {
    init,
    toggleDraw, scanArea, clearAll,
    filterCat,
    openScanPage, openPipelinePage, switchPipelineTab,
    markAreaDone, saveArea,
    openDetail, closeDetail,
    toggleStatus, toggleJobApplied, setRating, saveNotes, refreshJobs,
    copy, copyOutreach,
    verifyCompanyEmail, generateOutreachEmails, applyOutreachVariant, sendOutreachEmail,
    openProfile, closeProfile, closeProfileBackdrop, saveProfile, logout,
    resolveTeamLinkedIn, discoverPeople, reVerifyCompany, toggleMapMode,
    openAccountMenu,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
