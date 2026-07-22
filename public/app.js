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
    areaJobs: [],
    areaJobsSuburb: '',
    areaJobsLoading: false,
    search: '',
    sortBy: 'best',
    quickFilters: { roles: false, verified: false, email: false, team: false, match: false },
    pipelineSearch: '',
    pipelineKind: 'interested',
    pipelineSort: 'best',
    pageSize: 60,
    shownCount: 60,
    _listSig: null,
  };

  const _enriching = new Set();

  const AREAS_KEY = 'areahunt.areas.v1';

  // ---- init ---------------------------------------------------------------

  let appStarted = false;

  // The detail panel/backdrop sit below the topbar + coverage banner, whose
  // combined height isn't fixed — the topbar wraps to a second row on
  // narrower screens and the banner only appears sometimes (e.g. the
  // Google-Places-quota-exhausted fallback warning). A hardcoded top offset
  // drifts out of sync with either of those and the panel ends up
  // overlapping the banner text. Track the real height with a
  // ResizeObserver instead and expose it as a CSS variable.
  function syncHeaderHeight() {
    const topbar = document.querySelector('.topbar');
    const banner = document.getElementById('coverageBanner');
    const set = () => {
      const bannerH = banner && banner.style.display !== 'none' ? banner.offsetHeight : 0;
      const h = (topbar?.offsetHeight || 0) + bannerH;
      document.documentElement.style.setProperty('--header-h', `${h}px`);
    };
    set();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(set);
      if (topbar) ro.observe(topbar);
      if (banner) ro.observe(banner);
    } else {
      window.addEventListener('resize', set);
    }
  }

  function init() {
    syncHeaderHeight();
    handleVerifyRedirect();
    handleAlertsOffRedirect();
    AuthGate.boot((sess) => {
      applyUserProfile(sess.profile);
      showVerifyBanner(sess);
      if (!appStarted) {
        appStarted = true;
        initApp();
      } else {
        renderCompanies(true);
        if (state.companies.length) addMarkers();
      }
    });
  }

  // Handles the redirect back from clicking the link in a verification
  // email (see server/routes/auth.js's GET /verify-email) — shows a toast,
  // then strips the query param so a page refresh doesn't re-trigger it.
  function handleVerifyRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('verified')) return;
    const ok = params.get('verified') === '1';
    toast(ok ? 'Email verified!' : 'That verification link is invalid or has expired', ok ? 'success' : 'error');
    params.delete('verified');
    const qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  // Handles the redirect back from clicking "Turn off job alerts" in an
  // alert digest email (see server/routes/auth.js's GET /unsubscribe-alerts).
  function handleAlertsOffRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('alerts_off')) return;
    const ok = params.get('alerts_off') === '1';
    toast(ok ? "Job alerts turned off — you won't get any more of these emails" : 'That unsubscribe link is invalid', ok ? 'success' : 'error');
    params.delete('alerts_off');
    const qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  function showVerifyBanner(sess) {
    const banner = document.getElementById('verifyEmailBanner');
    if (!banner) return;
    if (!sess || sess.emailVerified) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    banner.innerHTML = `<strong>Verify your email</strong> — check your inbox for a link, or <a href="#" onclick="App.resendVerification();return false;">resend it</a>.`;
  }

  async function resendVerification() {
    try {
      const resp = await fetch('/api/auth/resend-verification', { method: 'POST', headers: AuthGate.authHeaders() });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Could not resend');
      toast(data.alreadyVerified ? 'Already verified' : 'Verification email sent', 'success');
    } catch (err) {
      toast(err.message || 'Could not resend verification email', 'error');
    }
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
        } else if (document.activeElement?.id === 'companySearch') {
          state.search = '';
          document.getElementById('companySearch').value = '';
          renderCompanies(true);
          document.getElementById('companySearch').blur();
        }
        return;
      }
      // "/" focuses the company search (unless already typing in a field).
      if (e.key === '/' && state.view === 'scan') {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!typing) {
          const el = document.getElementById('companySearch');
          if (el) { e.preventDefault(); el.focus(); }
        }
      }
    });

    loadProfile();
    renderIndustryFilters();
    initListControls();
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

  async function deleteAccount() {
    if (!window.confirm('Permanently delete your account, saved companies, notes, ratings, and applied history? This cannot be undone.')) return;
    const password = window.prompt('Enter your password to confirm:');
    if (password == null) return;
    try {
      await AuthGate.deleteAccount(password);
      closeProfile();
      toast('Account deleted', 'success');
    } catch (err) {
      toast('Could not delete account: ' + (err.message || 'try again'), 'error');
    }
  }

  function syncMapModeBtn() {
    const btn = document.getElementById('mapModeBtn');
    if (!btn) return;
    const dark = AreaHuntMap.getMode() === 'dark';
    btn.innerHTML = `<svg class="ui-icon no-gap" width="15" height="15"><use href="#icon-${dark ? 'sun' : 'moon'}"></use></svg>`;
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
      const data = await fetch(`/api/companies/in-bounds?bbox=${encodeURIComponent(q)}`, { headers: AuthGate.authHeaders() }).then(r => r.json());
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
    name: '', skills: [], city: '', portfolio: '', pitch: '', signature: '', emailAccount: null,
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

  function renderProfileChipGroup(containerId, options, selected, { exclusiveAll, exclusiveSingle } = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const sel = new Set(selected?.length ? selected : []);
    if (!sel.size && exclusiveAll) sel.add('all');
    el.innerHTML = options.map(o => {
      const id = o.id;
      const text = escapeHtml(o.label || id);
      const icon = o.icon && typeof AreaHuntIndustries !== 'undefined' ? AreaHuntIndustries.iconSvg(o.icon, 15) : '';
      const label = icon ? `<span class="chip-opt-label">${icon}<span>${text}</span></span>` : text;
      return `<button type="button" class="chip-opt ${sel.has(id) ? 'on' : ''}" data-id="${id}">${label}</button>`;
    }).join('');
    el.querySelectorAll('.chip-opt').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (exclusiveSingle) {
          const wasOn = btn.classList.contains('on');
          el.querySelectorAll('.chip-opt').forEach(b => b.classList.remove('on'));
          if (!wasOn) btn.classList.add('on');
          return;
        }
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
      icon: o.icon,
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

  function renderProfileCertifications(certifications = []) {
    const list = document.getElementById('profCertList');
    if (!list) return;
    const rows = certifications.length ? certifications : [{ name: '', issuer: '', year: '', url: '' }];
    list.innerHTML = rows.map((cert, idx) => `
      <div class="prof-cert-row" data-idx="${idx}">
        <input class="form-input" placeholder="Certification (e.g. Adobe Certified Expert)" data-field="name" value="${escapeAttr(cert.name || '')}" />
        <input class="form-input" placeholder="Issuing body" data-field="issuer" value="${escapeAttr(cert.issuer || '')}" />
        <input class="form-input" placeholder="Year" data-field="year" value="${escapeAttr(cert.year || '')}" />
        <input class="form-input" placeholder="Credential URL (optional)" data-field="url" value="${escapeAttr(cert.url || '')}" />
        ${idx > 0 ? '<button type="button" class="link-btn-small prof-remove-cert">Remove</button>' : ''}
      </div>`).join('');
    list.querySelectorAll('.prof-remove-cert').forEach(btn => {
      btn.onclick = () => btn.closest('.prof-cert-row')?.remove();
    });
  }

  function collectProfileCertifications() {
    const out = [];
    document.querySelectorAll('.prof-cert-row').forEach(row => {
      const entry = {};
      row.querySelectorAll('[data-field]').forEach(inp => {
        entry[inp.dataset.field] = inp.value.trim();
      });
      if (entry.name || entry.issuer) out.push(entry);
    });
    return out;
  }

  function renderProfileWorkHistory(workHistory = []) {
    const list = document.getElementById('profWorkList');
    if (!list) return;
    const rows = workHistory.length ? workHistory : [{ title: '', company: '', location: '', startDate: '', endDate: '', current: false, description: '' }];
    list.innerHTML = rows.map((w, idx) => `
      <div class="prof-work-row" data-idx="${idx}">
        <input class="form-input" placeholder="Job title" data-field="title" value="${escapeAttr(w.title || '')}" />
        <input class="form-input" placeholder="Company" data-field="company" value="${escapeAttr(w.company || '')}" />
        <div class="prof-work-split">
          <input class="form-input" placeholder="Location" data-field="location" value="${escapeAttr(w.location || '')}" />
          <input class="form-input" placeholder="Start (e.g. 2022)" data-field="startDate" value="${escapeAttr(w.startDate || '')}" />
          <input class="form-input" placeholder="End (or blank if current)" data-field="endDate" value="${escapeAttr(w.endDate || '')}" ${w.current ? 'disabled' : ''} />
        </div>
        <label class="form-label toggle-row prof-work-current">
          <input type="checkbox" data-field="current" ${w.current ? 'checked' : ''} />
          <span>I currently work here</span>
        </label>
        <textarea class="form-input" rows="2" placeholder="What you did — 1-2 lines, achievements if you have them" data-field="description">${escapeHtml(w.description || '')}</textarea>
        ${idx > 0 ? '<button type="button" class="link-btn-small prof-remove-work">Remove</button>' : ''}
      </div>`).join('');
    list.querySelectorAll('.prof-remove-work').forEach(btn => {
      btn.onclick = () => btn.closest('.prof-work-row')?.remove();
    });
    list.querySelectorAll('[data-field="current"]').forEach(cb => {
      cb.onchange = () => {
        const endInput = cb.closest('.prof-work-row')?.querySelector('[data-field="endDate"]');
        if (endInput) endInput.disabled = cb.checked;
      };
    });
  }

  function collectProfileWorkHistory() {
    const out = [];
    document.querySelectorAll('.prof-work-row').forEach(row => {
      const entry = {};
      row.querySelectorAll('[data-field]').forEach(inp => {
        entry[inp.dataset.field] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      });
      if (entry.title || entry.company) out.push(entry);
    });
    return out;
  }

  function renderProfileProjects(projects = []) {
    const list = document.getElementById('profProjectsList');
    if (!list) return;
    const rows = projects.length ? projects : [{ name: '', description: '', url: '', tech: '' }];
    list.innerHTML = rows.map((p, idx) => `
      <div class="prof-project-row" data-idx="${idx}">
        <input class="form-input" placeholder="Project name" data-field="name" value="${escapeAttr(p.name || '')}" />
        <textarea class="form-input" rows="2" placeholder="What it does / your role" data-field="description">${escapeHtml(p.description || '')}</textarea>
        <div class="prof-work-split">
          <input class="form-input" placeholder="Tech/tools used" data-field="tech" value="${escapeAttr(p.tech || '')}" />
          <input class="form-input" placeholder="Link (optional)" data-field="url" value="${escapeAttr(p.url || '')}" />
        </div>
        ${idx > 0 ? '<button type="button" class="link-btn-small prof-remove-project">Remove</button>' : ''}
      </div>`).join('');
    list.querySelectorAll('.prof-remove-project').forEach(btn => {
      btn.onclick = () => btn.closest('.prof-project-row')?.remove();
    });
  }

  function collectProfileProjects() {
    const out = [];
    document.querySelectorAll('.prof-project-row').forEach(row => {
      const entry = {};
      row.querySelectorAll('[data-field]').forEach(inp => {
        entry[inp.dataset.field] = inp.value.trim();
      });
      if (entry.name) out.push(entry);
    });
    return out;
  }

  function renderProfileLanguages(languages = []) {
    const list = document.getElementById('profLanguagesList');
    if (!list) return;
    const rows = languages.length ? languages : [{ name: '', level: '' }];
    list.innerHTML = rows.map((l, idx) => `
      <div class="prof-lang-row" data-idx="${idx}">
        <input class="form-input" placeholder="Language" data-field="name" value="${escapeAttr(l.name || '')}" />
        <select class="form-input" data-field="level">
          <option value="">Level…</option>
          ${['Conversational', 'Professional', 'Fluent', 'Native'].map(lvl =>
            `<option value="${lvl}" ${l.level === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
        </select>
        ${idx > 0 ? '<button type="button" class="link-btn-small prof-remove-lang">Remove</button>' : ''}
      </div>`).join('');
    list.querySelectorAll('.prof-remove-lang').forEach(btn => {
      btn.onclick = () => btn.closest('.prof-lang-row')?.remove();
    });
  }

  function collectProfileLanguages() {
    const out = [];
    document.querySelectorAll('.prof-lang-row').forEach(row => {
      const entry = {};
      row.querySelectorAll('[data-field]').forEach(inp => {
        entry[inp.dataset.field] = inp.value.trim();
      });
      if (entry.name) out.push(entry);
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
    document.getElementById('profEmailAccountEmail').value = p.emailAccount?.email || '';
    document.getElementById('profEmailAccountHost').value = p.emailAccount?.host || 'smtp.gmail.com';
    document.getElementById('profEmailAccountPort').value = p.emailAccount?.port || '587';
    // The app password is write-only — never sent back from the server, so
    // this field always starts blank; a placeholder communicates "already
    // saved" instead of leaving it looking unset.
    const pwInput = document.getElementById('profEmailAccountPassword');
    pwInput.value = '';
    pwInput.placeholder = p.emailAccount?.configured ? '•••••••••••••••• (saved — leave blank to keep)' : 'Paste an app password';
    const statusEl = document.getElementById('emailAccountStatus');
    if (statusEl) statusEl.textContent = p.emailAccount?.configured ? '— connected' : '— not set up yet';
    document.getElementById('profExpYears').value = p.experienceYears || '';
    document.getElementById('profCurrentRole').value = p.currentRole || '';
    document.getElementById('profExpSummary').value = p.experienceSummary || '';
    document.getElementById('profSummary').value = p.summary || '';
    document.getElementById('profGithub').value = p.links?.github || '';
    document.getElementById('profLinkedin').value = p.links?.linkedin || '';
    document.getElementById('profWebsite').value = p.links?.website || '';
    renderProfileWorkHistory(p.workHistory || []);
    const addWork = document.getElementById('profAddWork');
    if (addWork) {
      addWork.onclick = () => {
        const work = collectProfileWorkHistory();
        work.push({ title: '', company: '', location: '', startDate: '', endDate: '', current: false, description: '' });
        renderProfileWorkHistory(work);
      };
    }
    renderProfileProjects(p.projects || []);
    const addProject = document.getElementById('profAddProject');
    if (addProject) {
      addProject.onclick = () => {
        const projects = collectProfileProjects();
        projects.push({ name: '', description: '', url: '', tech: '' });
        renderProfileProjects(projects);
      };
    }
    renderProfileLanguages(p.languages || []);
    const addLanguage = document.getElementById('profAddLanguage');
    if (addLanguage) {
      addLanguage.onclick = () => {
        const languages = collectProfileLanguages();
        languages.push({ name: '', level: '' });
        renderProfileLanguages(languages);
      };
    }
    renderProfileCertifications(p.certifications || []);
    const addCert = document.getElementById('profAddCert');
    if (addCert) {
      addCert.onclick = () => {
        const certs = collectProfileCertifications();
        certs.push({ name: '', issuer: '', year: '', url: '' });
        renderProfileCertifications(certs);
      };
    }
    renderProfileIndustryChips(p.jobSectors || []);
    const formOpts = AuthGate.getProfileFormOptions?.() || {};
    renderProfileChipGroup('profEmployment', formOpts.employmentTypes || [], p.employmentTypes || []);
    renderProfileChipGroup('profWorkMode', formOpts.workModes || [], p.workModes || []);
    renderProfileChipGroup('profTimeCommitment', formOpts.timeCommitment || [], p.timeCommitment ? [p.timeCommitment] : [], { exclusiveSingle: true });
    renderProfileChipGroup('profWorkRights', formOpts.workRights || [], p.workRights ? [p.workRights] : [], { exclusiveSingle: true });
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
      timeCommitment: readProfileChipSelection('profTimeCommitment')[0] || '',
      workRights: readProfileChipSelection('profWorkRights')[0] || '',
      education: collectProfileEducation(),
      experienceYears: document.getElementById('profExpYears').value || '',
      currentRole: document.getElementById('profCurrentRole').value.trim(),
      experienceSummary: document.getElementById('profExpSummary').value.trim(),
      certifications: collectProfileCertifications(),
      summary: document.getElementById('profSummary').value.trim(),
      workHistory: collectProfileWorkHistory(),
      projects: collectProfileProjects(),
      languages: collectProfileLanguages(),
      links: {
        github: document.getElementById('profGithub').value.trim(),
        linkedin: document.getElementById('profLinkedin').value.trim(),
        website: document.getElementById('profWebsite').value.trim(),
      },
      skills,
      portfolio: portfolioVal,
      portfolioUrl: portfolioVal,
      portfolioRequired: !!document.getElementById('profPortfolioRequired').checked,
      portfolioNotes: document.getElementById('profPortfolioNotes').value.trim(),
      pitch: document.getElementById('profPitch').value.trim(),
      signature: document.getElementById('profSig').value.trim() || name,
      emailAccount: {
        email: document.getElementById('profEmailAccountEmail').value.trim(),
        host: document.getElementById('profEmailAccountHost').value.trim() || 'smtp.gmail.com',
        port: document.getElementById('profEmailAccountPort').value.trim() || '587',
        appPassword: document.getElementById('profEmailAccountPassword').value,
      },
    };
  }

  async function openProfile() {
    let p = profile;
    const sess = AuthGate.getSession?.();
    if (sess) {
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
    const alertsBox = document.getElementById('profAlertsEnabled');
    if (alertsBox) alertsBox.checked = AuthGate.getSession?.()?.alertsEnabled !== false;
    const consentBox = document.getElementById('profTrainingConsent');
    if (consentBox) consentBox.checked = AuthGate.getSession?.()?.trainingDataConsent === true;
    const themeBox = document.getElementById('profAppleTheme');
    if (themeBox) themeBox.checked = AuthGate.getSession?.()?.themePreference === 'apple';
    document.getElementById('profileModal').classList.add('show');
  }

  async function toggleAlerts(enabled) {
    try {
      const resp = await fetch('/api/auth/alerts', {
        method: 'PATCH',
        headers: { ...AuthGate.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) throw new Error('failed');
      const sess = AuthGate.getSession?.();
      if (sess) sess.alertsEnabled = enabled;
      toast(enabled ? 'Job alerts turned on' : 'Job alerts turned off', 'success');
    } catch {
      toast('Could not update job alerts — try again', 'error');
      const box = document.getElementById('profAlertsEnabled');
      if (box) box.checked = !enabled;
    }
  }

  async function toggleTrainingConsent(enabled) {
    try {
      const resp = await fetch('/api/auth/training-consent', {
        method: 'PATCH',
        headers: { ...AuthGate.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) throw new Error('failed');
      const sess = AuthGate.getSession?.();
      if (sess) sess.trainingDataConsent = enabled;
      toast(enabled ? 'Thanks — you\'re now contributing anonymized data' : 'Turned off — you\'re excluded from future exports', 'success');
    } catch {
      toast('Could not update this setting — try again', 'error');
      const box = document.getElementById('profTrainingConsent');
      if (box) box.checked = !enabled;
    }
  }

  async function toggleTheme(useApple) {
    const value = useApple ? 'apple' : 'dark';
    try {
      const resp = await fetch('/api/auth/theme', {
        method: 'PATCH',
        headers: { ...AuthGate.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!resp.ok) throw new Error('failed');
      const sess = AuthGate.getSession?.();
      if (sess) sess.themePreference = value;
      AuthGate.applyTheme(value);
      if (window.AreaHuntMap?.setMode) window.AreaHuntMap.setMode(value === 'apple' ? 'light' : 'dark');
      toast(useApple ? 'Apple design mode turned on' : 'Apple design mode turned off', 'success');
    } catch {
      toast('Could not update theme — try again', 'error');
      const box = document.getElementById('profAppleTheme');
      if (box) box.checked = !useApple;
    }
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
    if (sess) {
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
      if (sess) {
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

  async function downloadPdf(url, filename, btn, busyLabel) {
    const sess = AuthGate.getSession?.();
    if (!sess) {
      toast('Sign in first', 'error');
      return;
    }
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="inline-spinner"></span>${busyLabel}`; }
    try {
      const resp = await fetch(url, { headers: AuthGate.authHeaders() });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Could not generate PDF');
      }
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      toast('Downloaded', 'success');
    } catch (err) {
      toast(err.message || 'Could not generate PDF', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  function downloadResume() {
    const btn = document.querySelector('.resume-download-btn');
    const name = (profile.name || 'resume').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadPdf('/api/profile/resume.pdf', `${name}-resume.pdf`, btn, 'Building…');
  }

  function downloadCoverLetter(id) {
    const c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    const btn = document.getElementById('coverLetterBtn-' + id);
    const name = (profile.name || 'cover-letter').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const company = (c?.name || 'company').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadPdf(`/api/companies/${encodeURIComponent(id)}/cover-letter.pdf`, `${name}-cover-letter-${company}.pdf`, btn, 'Writing…');
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

      const serperBanner = document.getElementById('serperBanner');
      if (serperBanner) {
        if (h.serperState === 'budget-exceeded' || h.serperState === 'error') {
          serperBanner.style.display = '';
          serperBanner.innerHTML = `<strong>Job-board search paused</strong> — ${escapeHtml(h.serperMessage || 'Seek/Indeed/LinkedIn/Jora search and LinkedIn lookup are temporarily unavailable.')}`;
        } else {
          serperBanner.style.display = 'none';
        }
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
    btn.innerHTML = state.isDrawing
      ? '<svg class="ui-icon" width="13" height="13"><use href="#icon-close"></use></svg>Cancel draw'
      : '<svg class="ui-icon" width="13" height="13"><use href="#icon-draw-area"></use></svg>Draw area';
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
      doneBtn.innerHTML = `<svg class="ui-icon" width="12" height="12"><use href="#icon-check"></use></svg>${isDone ? 'Done' : 'Mark done'}`;
      doneBtn.disabled = isDone;
    }
    if (saveBtn) {
      saveBtn.innerHTML = `<svg class="ui-icon" width="12" height="12"><use href="#icon-bookmark"></use></svg>${isSaved ? 'Saved' : 'Save area'}`;
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
    btn.innerHTML = '<span class="inline-spinner" style="border-top-color:#fff;border-color:rgba(255,255,255,0.35)"></span>Scanning…';
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
        headers: AuthGate.authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      state.companies = data.companies || [];
      state.shownCount = state.pageSize;
      saveSessionScan(state.selBounds);
      renderCompanies(true);
      addMarkers();
      updateStats();
      // The backend silently falls back to OpenStreetMap when Google Places
      // fails (e.g. daily quota exhausted) — surface that here instead of
      // letting the results just look sparse with no explanation. The
      // startup coverage banner only reflects whether a key is *configured*,
      // not whether it actually worked for this specific scan.
      const banner = document.getElementById('coverageBanner');
      if (banner && data.fellBack) {
        banner.style.display = '';
        banner.innerHTML = `<strong>Google Places unavailable for this scan</strong> — fell back to OpenStreetMap (sparser coverage). ${escapeHtml(data.fallbackReason || '')}`;
      }
      toast(`Found ${data.count} businesses — loading contact info`, 'success');
      // Kick off background enrichment for everything else.
      backgroundEnrichAll();
      // Area-wide job-board search — catches roles whose employer wasn't found
      // in the Places sweep. Runs independently so it never blocks the map.
      if (data.areaJobsEnabled) fetchAreaJobs(payload);
    } catch (err) {
      console.error(err);
      toast('Scan failed: ' + err.message, 'error');
    } finally {
      bar.remove();
      btn.innerHTML = '<svg class="ui-icon" width="13" height="13"><use href="#icon-lightning"></use></svg>Scan companies';
      btn.disabled = false;
      btn.style.display = 'none';
      progress.classList.remove('show');
    }
  }

  // Targets the search at the user's own selected industries (e.g. Design +
  // Dev + AI + VR) instead of a generic unfiltered "jobs here" search —
  // capped at 4 to match the server-side cap (server/routes/scan.js).
  function areaJobSearchTerms() {
    const sectors = (profile.jobSectors || []).filter(id => id !== 'all');
    return sectors
      .map(id => window.AreaHuntIndustries?.roleSearchTerm?.(id))
      .filter(Boolean)
      .slice(0, 4);
  }

  async function fetchAreaJobs(bounds) {
    state.areaJobsLoading = true;
    state.areaJobs = [];
    renderCompanies();
    try {
      const resp = await fetch('/api/scan/area-jobs', {
        method: 'POST',
        headers: AuthGate.authHeaders(),
        body: JSON.stringify({ ...bounds, terms: areaJobSearchTerms() }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      state.areaJobs = data.jobs || [];
      state.areaJobsSuburb = data.suburb || '';
      if (state.areaJobs.length) {
        toast(`+${state.areaJobs.length} more roles on job boards in ${state.areaJobsSuburb || 'this area'}`, 'success');
      }
    } catch (err) {
      console.warn('area jobs failed', err);
    } finally {
      state.areaJobsLoading = false;
      renderCompanies();
    }
  }

  function renderAreaJobsBanner() {
    if (state.view !== 'scan') return '';
    if (state.areaJobsLoading) {
      return `<div class="area-jobs-banner loading"><span class="inline-spinner"></span>Searching Seek, Indeed, LinkedIn, Jora, CareerOne &amp; Careers Vic for more roles in this area…</div>`;
    }
    if (!state.areaJobs.length) return '';
    const labels = { seek: 'Seek', indeed: 'Indeed', 'linkedin-jobs': 'LinkedIn', jora: 'Jora', careerone: 'CareerOne', 'careers-vic': 'Careers Vic' };
    const needsVisa = ['visa-full', 'visa-limited', 'visa-sponsorship', 'working-holiday'].includes(profile.workRights);
    const rows = state.areaJobs.slice(0, 40).map(j => {
      const src = labels[j.source] || j.source;
      const co = j.company_name ? `<span class="area-job-co">${escapeHtml(j.company_name)}</span>` : '';
      let visaBadge = '';
      if (j.visa_flag === 'sponsorship-available') visaBadge = `<span style="color:var(--green)">${ic('check', 12)}Sponsorship mentioned</span>`;
      else if (needsVisa && (j.visa_flag === 'citizens-only' || j.visa_flag === 'clearance-required')) {
        visaBadge = `<span style="color:var(--red)">${ic('warning', 12)}${j.visa_flag === 'clearance-required' ? 'Clearance required' : 'Citizens/PR only'}</span>`;
      }
      return `
        <a class="area-job-row" href="${escapeAttr(j.url)}" target="_blank" rel="noopener">
          <div class="area-job-main">
            <div class="area-job-title">${escapeHtml(j.title)}</div>
            ${co}
          </div>
          <div class="area-job-meta">
            ${j.location ? `<span>${ic('pin', 12)}${escapeHtml(j.location)}</span>` : ''}
            ${j.remote ? `<span class="remote">${ic('globe', 12)}Remote</span>` : ''}
            ${visaBadge}
            <span class="trust-badge board">${escapeHtml(src)}</span>
          </div>
        </a>`;
    }).join('');
    return `
      <details class="area-jobs-banner" open>
        <summary>${ic('admin', 13)}${state.areaJobs.length} extra roles on job boards${state.areaJobsSuburb ? ` · ${escapeHtml(state.areaJobsSuburb)}` : ''} <span class="area-jobs-hint">(employers not necessarily on the map)</span></summary>
        <div class="area-jobs-list">${rows}</div>
      </details>`;
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
    // Markers mirror exactly what the list shows, so search + quick filters
    // narrow the map too.
    const q = state.search.trim();
    return state.companies.filter(c => {
      if (c.status === 'skipped') return false;
      if (!companyPassesIndustryFilter(c)) return false;
      if (!companyPassesQuickFilters(c)) return false;
      if (!companyMatchesSearch(c, q)) return false;
      return true;
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
      if (c.email_source === 'careers_prefix') return `${ic('check')}Verified careers email on their domain`;
      if (c.email_source === 'contact_page') return `${ic('check')}Contact email on their website`;
      return `${ic('check')}Email matches their website domain`;
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
      return `<div class="trust-banner warn">${ic('warning')}${escapeHtml(c.enrich_error)} — data may be incomplete. <button class="link-btn-small" onclick="App.reVerifyCompany('${escapeAttr(c.id)}')">Try again</button></div>`;
    }
    const trust = c.profile?.trust;
    if (trust?.summary) {
      const cls = trust.level === 'high' ? '' : (trust.level === 'medium' ? ' medium' : ' warn');
      return `<div class="trust-banner${cls}">Trust — ${escapeHtml(trust.summary)}.</div>`;
    }
    const parts = [];
    if (isVerifiedEmail(c)) parts.push('verified email on their domain');
    else if (c.email) parts.push('email found but not domain-verified');
    const unverifiedLi = (c.team || []).filter(m => m.linkedin_url && !isVerifiedLinkedIn(m)).length;
    if ((c.team || []).some(isVerifiedLinkedIn)) parts.push('verified LinkedIn where sourced from their site');
    if (unverifiedLi) parts.push(`${unverifiedLi} team link${unverifiedLi !== 1 ? 's' : ''} need manual check`);
    const summary = parts.length ? parts.join(' · ') : 'confirm contact details on their website before outreach';
    return `<div class="trust-banner">Trust — ${escapeHtml(summary)}.</div>`;
  }

  function jobTrustLabel(source, job) {
    const conf = job?.confidence || null;
    if (conf === 'verified' || ['greenhouse', 'lever', 'workable', 'ashby', 'json-ld', 'jobadder'].includes(source)) {
      return `<span class="trust-badge verified">${ic('check')}Verified listing</span>`;
    }
    if (conf === 'board' || ['seek', 'indeed', 'linkedin-jobs', 'jora'].includes(source)) {
      const label = { seek: 'Seek', indeed: 'Indeed', 'linkedin-jobs': 'LinkedIn Jobs', jora: 'Jora' }[source] || source;
      return `<span class="trust-badge board">Job board · ${escapeHtml(label)}</span>`;
    }
    if (conf === 'found' || source === 'careers-page') {
      const hasRealLink = job?.url && !/^https?:\/\/[^/]+\/?$/i.test(job.url.replace(/\/+$/, ''));
      return hasRealLink
        ? '<span class="trust-badge found">Found on careers page</span>'
        : '<span class="trust-badge warn">Unverified — confirm on their site</span>';
    }
    return '<span class="trust-badge warn">Unverified</span>';
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

  // --- search / sort / quick filters --------------------------------------

  function companyOpenRoles(c) { return (c.jobs || []).length; }

  // Average repost_count across a company's open roles — lower means its
  // postings look genuinely open rather than already informally filled.
  // Companies with no job data yet sort last, not first (Infinity).
  function companyContestedness(c) {
    const jobs = c.jobs || [];
    if (!jobs.length) return Infinity;
    const repostSum = jobs.reduce((sum, j) => sum + (j.repost_count || 0), 0);
    return repostSum / jobs.length;
  }

  function companyIsVerified(c) {
    if (c.profile?.trust?.level === 'high') return true;
    if (isVerifiedEmail(c)) return true;
    if ((c.jobs || []).some(j => j.confidence === 'verified' || j.is_verified)) return true;
    if (c.profile?.linkedin?.verified) return true;
    if ((c.team || []).some(isVerifiedLinkedIn)) return true;
    return false;
  }

  function companyMatchCount(c) {
    const kws = profileSkillKeywords();
    return (c.opportunities || []).filter(o => oppMatchesProfile(o, kws)).length;
  }

  function companyMatchesSearch(c, q) {
    if (!q) return true;
    const hay = [
      c.name, c.type, c.address, c.description,
      ...(c.opportunities || []),
      ...((c.jobs || []).map(j => j.title)),
      hostnameOf(c.website || ''),
    ].join(' ').toLowerCase();
    // every whitespace-separated token must appear somewhere
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
  }

  function companyPassesQuickFilters(c) {
    const qf = state.quickFilters;
    if (qf.roles && companyOpenRoles(c) === 0) return false;
    if (qf.verified && !companyIsVerified(c)) return false;
    if (qf.email && !isVerifiedEmail(c)) return false;
    if (qf.team && !(c.team || []).length) return false;
    if (qf.match && companyMatchCount(c) === 0) return false;
    return true;
  }

  function companyRank(c) {
    // Composite "best" score: verified > roles > match > enriched > team,
    // nudged by what the learning model has picked up from your own save/
    // apply/skip history and pulled down for companies with job postings
    // that look fake/scammy.
    let s = 0;
    if (companyIsVerified(c)) s += 1000;
    s += Math.min(companyOpenRoles(c), 20) * 40;
    s += companyMatchCount(c) * 25;
    if (isVerifiedEmail(c)) s += 60;
    if (c.enriched_at) s += 10;
    s += Math.min((c.team || []).length, 10) * 3;
    s += (c.profile?.learned_score || 0) * 100;
    s -= (c.profile?.suspicious_job_count || 0) * 60;
    return s;
  }

  function sortCompanies(list, by = state.sortBy, source = state.companies) {
    const idx = new Map(source.map((c, i) => [String(c.id), i]));
    const arr = list.slice();
    arr.sort((a, b) => {
      switch (by) {
        case 'roles':    return companyOpenRoles(b) - companyOpenRoles(a) || companyRank(b) - companyRank(a);
        case 'verified': return (companyIsVerified(b) ? 1 : 0) - (companyIsVerified(a) ? 1 : 0) || companyRank(b) - companyRank(a);
        case 'match':    return companyMatchCount(b) - companyMatchCount(a) || companyRank(b) - companyRank(a);
        case 'name':     return String(a.name || '').localeCompare(String(b.name || ''));
        case 'recent':   return (idx.get(String(b.id)) ?? 0) - (idx.get(String(a.id)) ?? 0);
        case 'least-contested': return companyContestedness(a) - companyContestedness(b) || companyRank(b) - companyRank(a);
        case 'best':
        default:         return companyRank(b) - companyRank(a);
      }
    });
    return arr;
  }

  function filteredCompanies() {
    const q = state.search.trim();
    return state.companies.filter(c => {
      if (c.status === 'skipped') return false;
      if (!companyPassesIndustryFilter(c)) return false;
      if (!companyPassesQuickFilters(c)) return false;
      if (!companyMatchesSearch(c, q)) return false;
      return true;
    });
  }

  async function refreshPipelineCounts() {
    try {
      const [saved, applied] = await Promise.all([
        fetch('/api/companies/pipeline?kind=interested', { headers: AuthGate.authHeaders() }).then(r => r.json()),
        fetch('/api/companies/pipeline?kind=applied', { headers: AuthGate.authHeaders() }).then(r => r.json()),
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
    listEl.innerHTML = '<div class="empty-state"><span class="inline-spinner big-spinner"></span><p>Loading…</p></div>';
    try {
      const data = await fetch(`/api/companies/pipeline?kind=${encodeURIComponent(kind)}`, { headers: AuthGate.authHeaders() }).then(r => r.json());
      state.pipelineCompanies = data.companies || [];
      state.pipelineKind = kind;
      renderPipelineList();
    } catch {
      listEl.innerHTML = `<div class="empty-state"><div class="big-icon">${ic('warning', 40, false)}</div><h3>Could not load</h3><p>Check your connection and try again.</p></div>`;
    }
  }

  function renderPipelineList() {
    const listEl = document.getElementById('pipelineList');
    if (!listEl) return;
    const kind = state.pipelineKind || 'interested';
    const all = state.pipelineCompanies || [];
    if (!all.length) {
      const label = kind === 'interested' ? 'saved' : 'applied';
      listEl.innerHTML = `<div class="empty-state"><div class="big-icon">${ic(kind === 'interested' ? 'nonprofit' : 'check', 40, false)}</div><h3>No ${label} companies yet</h3><p>Mark companies from your scan results — they appear here across all areas.</p></div>`;
      return;
    }
    const q = (state.pipelineSearch || '').trim();
    const filtered = q ? all.filter(c => companyMatchesSearch(c, q)) : all;
    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="big-icon">${ic('search', 40, false)}</div><h3>No matches</h3><p>No saved companies match “${escapeHtml(q)}”.</p></div>`;
      return;
    }
    const sorted = sortCompanies(filtered, state.pipelineSort, all);
    listEl.innerHTML = sorted.map(renderCard).join('');
  }

  function updateResultCount(shown) {
    const el = document.getElementById('resultCount');
    if (!el) return;
    const total = state.companies.filter(c => c.status !== 'skipped').length;
    if (!total) { el.textContent = ''; return; }
    el.textContent = shown === total
      ? `${total} found`
      : `${shown} of ${total}`;
  }

  let _listObserver = null;

  function renderCompaniesNow() {
    const list = document.getElementById('companyList');
    const filtered = sortCompanies(filteredCompanies());
    refreshPipelineCounts();
    syncToolbarState();
    updateResultCount(filtered.length);

    const areaJobsHTML = renderAreaJobsBanner();

    if (state.companies.length === 0) {
      list.innerHTML = areaJobsHTML || `<div class="empty-state"><div class="big-icon">${ic('draw-area', 40, false)}</div><h3>No area scanned yet</h3><p>Click <strong>Draw area</strong> and drag a rectangle on the map.</p></div>`;
      return;
    }
    if (filtered.length === 0) {
      const searching = state.search.trim() || Object.values(state.quickFilters).some(Boolean);
      const body = searching
        ? `<div class="empty-state"><div class="big-icon">${ic('search', 40, false)}</div><h3>No matches</h3><p>Nothing fits your search and filters. <button class="link-btn-small" onclick="App.resetListControls()">Reset filters</button></p></div>`
        : `<div class="empty-state"><div class="big-icon">${ic('search', 40, false)}</div><h3>No matches</h3><p>Try a different industry filter or scan a larger area.</p></div>`;
      list.innerHTML = areaJobsHTML + body;
      return;
    }

    // Reset the page window whenever the filter/sort signature changes, so a
    // new search starts from the top instead of keeping a huge expanded list.
    const sig = JSON.stringify([state.search, state.sortBy, state.quickFilters, state.activeCats]);
    if (sig !== state._listSig) {
      state._listSig = sig;
      state.shownCount = state.pageSize;
    }

    const shown = Math.min(state.shownCount, filtered.length);
    const remaining = filtered.length - shown;
    const cardsHTML = filtered.slice(0, shown).map(renderCard).join('');
    const moreHTML = remaining > 0
      ? `<button type="button" class="load-more-btn" id="loadMoreBtn" onclick="App.loadMoreCompanies()">Load more · ${remaining} more</button>`
      : '';

    list.innerHTML = areaJobsHTML + cardsHTML + moreHTML;

    // Auto-load the next page when the button scrolls into view.
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
    if (remaining > 0) {
      const btn = document.getElementById('loadMoreBtn');
      if (btn && 'IntersectionObserver' in window) {
        _listObserver = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) loadMoreCompanies();
        }, { root: list, rootMargin: '300px' });
        _listObserver.observe(btn);
      }
    }
  }

  function loadMoreCompanies() {
    state.shownCount += state.pageSize;
    renderCompaniesNow();
  }

  const STAGE_LABELS = {
    interested: 'Interested', applied: 'Applied', interviewing: 'Interviewing',
    offer: 'Offer', rejected: 'Rejected',
  };

  // Post-apply pipeline stages beyond the original binary applied/not —
  // each gets its own badge/color instead of collapsing into the same
  // generic "Applied" tick, so a rejection doesn't look identical to a
  // company still awaiting a reply.
  function stageBadge(status) {
    if (status === 'interviewing') return `<span class="stage-pill stage-interviewing" title="Interviewing">${ic('sparkles', 11)}Interviewing</span>`;
    if (status === 'offer') return `<span class="stage-pill stage-offer" title="Offer received">${ic('check', 11)}Offer</span>`;
    if (status === 'rejected') return `<span class="stage-pill stage-rejected" title="Rejected">${ic('close', 11, false)}Rejected</span>`;
    return '';
  }

  function renderCard(c) {
    const appliedJobs = (c.jobs || []).filter(j => j.applied).length;
    const totalJobs = (c.jobs || []).length;
    const stage = ['applied', 'interviewing', 'offer', 'rejected'].includes(c.status) ? c.status : null;
    const isApplied = c.status === 'applied' || appliedJobs > 0;
    const isInPipeline = !!stage || appliedJobs > 0;
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
      chips.push(`<a class="contact-chip email verified" href="mailto:${escapeAttr(c.email)}" onclick="event.stopPropagation()" title="${escapeAttr(c.email)}">${ic('email', 12)}${escapeHtml(shortEmail(c.email))}</a>`);
    } else if (c.email) {
      chips.push(`<span class="contact-chip email unverified" title="Unverified — confirm before emailing">${ic('email', 12)}${escapeHtml(shortEmail(c.email))} ?</span>`);
    }
    if (c.website) {
      const host = hostnameOf(c.website);
      chips.push(`<a class="contact-chip site" href="${escapeAttr(c.website)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${escapeAttr(c.website)}">${ic('globe', 12)}${escapeHtml(host)}</a>`);
    }
    if (totalJobs) {
      chips.push(`<span class="contact-chip jobs">${ic('briefcase', 12)}${totalJobs} role${totalJobs !== 1 ? 's' : ''}</span>`);
    }
    const team = c.team || [];
    if (team.length) {
      chips.push(`<span class="contact-chip team">${ic('hr', 12)}${team.length} team</span>`);
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
          ? `<a class="team-mini verified" href="${escapeAttr(m.linkedin_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${escapeAttr(m.title || m.name)}">${escapeHtml(m.name.split(' ')[0])} ${ic('external-link', 10, false)}</a>`
          : `<span class="team-mini" title="Search LinkedIn for ${escapeAttr(m.name)}">${escapeHtml(m.name.split(' ')[0])}</span>`
      ).join('')}${extra ? `<span class="team-mini-more">+${extra} more</span>` : ''}</div>`;
    })() : '';

    // Show a spinner while this card is actively being fetched, or — once
    // enrichment has actually finished and genuinely turned up nothing — a
    // quiet note instead of just silently having a shorter card than its
    // neighbours with no explanation for why.
    const sid = String(c.id);
    const hasAnyExtra = !!(chipsHTML || descHTML || teamPreview || oppsHTML);
    let enrichingHint = '';
    if (_enriching.has(sid)) {
      enrichingHint = `<div class="card-enriching"><span class="card-spinner"></span>${c.enrich_depth === 'full' ? 'Deep scanning…' : 'Fetching contact info…'}</div>`;
    } else if (c.enriched_at && !hasAnyExtra) {
      enrichingHint = `<div class="card-enriching muted">No public contact info or jobs found on their website</div>`;
    }

    const cid = escapeAttr(c.id);
    const logo = faviconHtml(c, 36);
    const matchBadge = matchCount > 0
      ? `<span class="match-pill" title="${matchCount} of your skills match likely opportunities">${ic('logo', 11)}Match</span>` : '';
    const verifiedBadge = companyIsVerified(c)
      ? `<span class="verified-pill" title="Verified data — sourced from their own website / ATS">${ic('check', 11)}Verified</span>` : '';
    const learnedScore = c.profile?.learned_score || 0;
    const learnedBadge = learnedScore > 0.3
      ? `<span class="learned-pill" title="Based on companies you've saved/applied to before">${ic('sparkles', 11)}Recommended</span>` : '';
    const suspiciousCount = c.profile?.suspicious_job_count || 0;
    const suspiciousBadge = suspiciousCount > 0
      ? `<span class="suspicious-pill" title="${suspiciousCount} job posting${suspiciousCount !== 1 ? 's' : ''} here has red flags — check before applying">${ic('warning', 11)}Check listing${suspiciousCount !== 1 ? 's' : ''}</span>` : '';

    return `
      <div class="company-card ${isInPipeline ? 'applied' : ''} ${isSkipped ? 'skipped' : ''} ${!isInPipeline && verifiedBadge ? 'is-verified' : ''} ${String(state.selectedId) === String(c.id) ? 'selected' : ''}" data-id="${cid}">
        <div class="card-top">
          ${logo}
          <div class="card-info">
            <div class="company-name-row">
              <span class="company-name">${escapeHtml(c.name)}</span>
              ${stage && stage !== 'applied' ? stageBadge(stage) : (isApplied ? `<span class="applied-tick" title="Applied">${ic('check', 11, false)}</span>` : '')}
              ${verifiedBadge}
              ${matchBadge}
              ${learnedBadge}
              ${suspiciousBadge}
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
            ${c.status === 'applied' ? `${ic('check', 12)}Applied` : `${ic('email', 12)}Applied`}
          </button>
          <button class="action-btn heart-btn ${c.status === 'interested' ? 'applied' : ''}" onclick="event.stopPropagation();App.toggleStatus('${cid}', 'interested')">
            ${ic('nonprofit', 12)}${c.status === 'interested' ? 'Saved' : 'Save'}
          </button>
          <button class="action-btn skip" onclick="event.stopPropagation();App.toggleStatus('${cid}', 'skipped')" ${c.status === 'skipped' ? 'style="color:var(--red);border-color:var(--red)"' : ''}>${ic('close', 12, false)}</button>
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
    if (!name) return ic('building', 16, false);
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
    const verified = member.linkedin_verified || isVerifiedLinkedIn(member);
    const profileUrl = verified ? member.linkedin_url : null;
    const searchUrl = member.linkedin_search_url || linkedinSearchUrl(member.name, c.name, c.address);
    const linkLabel = verified
      ? (member.linkedin_source === 'website'
        ? `<a class="li-found" href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ic('check')}LinkedIn (from their website) ${ic('external-link', 11, false)}</a>`
        : member.linkedin_source === 'linkedin_company'
          ? `<a class="li-found" href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ic('check')}Verified on company LinkedIn ${ic('external-link', 11, false)}</a>`
          : `<a class="li-found" href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${ic('check')}Verified profile ${ic('external-link', 11, false)}</a>`)
      : `<span class="li-none">No verified LinkedIn</span>
         <a class="li-search-btn" href="${escapeAttr(searchUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Search LinkedIn ${ic('external-link', 11, false)}</a>`;
    // Scraped titles come from LinkedIn/Google search snippets, not structured
    // data — they're sometimes a full marketing tagline ("MD @ X | Transforming
    // Tomorrow, Today") rather than a short role. Cap both fields hard so one
    // long scrape can't balloon a card's height (and stretch its grid row-mate
    // into an empty void — CSS grid rows stretch to the tallest cell).
    const titleText = member.title ? truncate(member.title, 60) : '';
    const bioHTML = member.bio
      ? `<div class="team-bio">${escapeHtml(truncate(member.bio, 110))}</div>`
      : '';
    const emailHTML = member.email && emailMatchesWebsite(member.email, c.website)
      ? `<div class="team-email"><a href="mailto:${escapeAttr(member.email)}" onclick="event.stopPropagation()">${escapeHtml(member.email)}</a></div>`
      : '';
    const Tag = verified ? 'a' : 'div';
    const attrs = verified
      ? `href="${escapeAttr(profileUrl)}" target="_blank" rel="noopener" title="Open verified LinkedIn profile"`
      : `title="No verified LinkedIn — use search link below"`;
    return `
      <${Tag} class="team-card ${verified ? 'has-li verified-li' : 'no-li'}" ${attrs}>
        <div class="team-avatar" style="background:hsl(${hue}, 50%, 30%); color:hsl(${hue}, 90%, 88%)">${escapeHtml(initials)}</div>
        <div class="team-info">
          <div class="team-name">${escapeHtml(member.name)}</div>
          ${titleText ? `<div class="team-title">${escapeHtml(titleText)}</div>` : ''}
          ${bioHTML}
          ${emailHTML}
          <div class="team-li-row">${linkLabel}</div>
        </div>
      </${Tag}>`;
  }

  function renderCompanyLinksSection(c) {
    const links = c.profile?.links || [];
    if (!links.length) return '';
    const icons = {
      website: 'globe', careers: 'briefcase', linkedin_company: 'briefcase',
      instagram: 'creative', facebook: 'thumb', tiktok: 'music-note',
    };
    const textIcons = { twitter: '𝕏', youtube: '▶' };
    const chips = links.map(l =>
      `<a class="company-link-chip ${l.verified ? 'verified' : ''}" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${icons[l.kind] ? ic(icons[l.kind]) : (textIcons[l.kind] || ic('link-chain'))}${escapeHtml(l.label)} ${ic('external-link', 11)}</a>`,
    ).join('');
    return `
      <div class="detail-section">
        <div class="detail-label">Company links</div>
        <div class="company-links-row">${chips}</div>
      </div>`;
  }

  function renderTeamEmptyActions(c) {
    const coPeople = linkedinCompanyPeopleUrl(c);
    const peopleSearch = linkedinPeopleSearchUrl(c);
    return `
      <div class="team-empty-actions">
        <button class="mini-btn" onclick="App.discoverPeople('${escapeAttr(c.id)}')">${ic('search', 12)}Find people on LinkedIn</button>
        ${coPeople
          ? `<a class="mini-btn mini-btn-link" href="${escapeAttr(coPeople)}" target="_blank" rel="noopener">${ic('hr', 12)}All employees on LinkedIn ${ic('external-link', 11, false)}</a>`
          : `<a class="mini-btn mini-btn-link" href="${escapeAttr(peopleSearch)}" target="_blank" rel="noopener">${ic('hr', 12)}Search people on LinkedIn ${ic('external-link', 11, false)}</a>`}
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
          <div class="empty-hint"><span class="inline-spinner"></span>Deep-scanning website &amp; LinkedIn for team members…</div>
        </div>`;
      }
      if (!c.enriched_at) {
        return `<div class="detail-section">
          <div class="detail-label">People at ${escapeHtml(c.name)}</div>
          <div class="empty-hint"><span class="inline-spinner"></span>Scanning website &amp; LinkedIn for team members…</div>
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
          <button class="link-btn-small" onclick="App.discoverPeople('${escapeAttr(c.id)}')">${ic('refresh', 11)}Re-verify LinkedIn</button>
        </div>
        ${note}
        <div class="team-grid" id="teamGrid-${escapeAttr(c.id)}">
          ${team.map(m => renderTeamCard(c, m)).join('')}
        </div>
        ${coPeople ? `<a class="team-all-li" href="${escapeAttr(coPeople)}" target="_blank" rel="noopener">Browse all employees on LinkedIn company page ${ic('external-link', 11, false)}</a>` : ''}
      </div>`;
  }

  function renderJobsSection(c) {
    const jobs = c.jobs || [];
    const jobsHTML = jobs.length
      ? jobs.map(renderJobRow).join('')
      : `<div class="empty-hint">${c.careers_url
          ? `No open roles detected on their careers page yet. <a href="${escapeAttr(c.careers_url)}" target="_blank" rel="noopener">Open careers page ${ic('external-link', 11, false)}</a> or try ${ic('refresh', 11, false)} Scan jobs.`
          : c.enriched_at
            ? (state.hasSerperKey
              ? 'No roles on their website yet. Scan jobs checks careers page first, then Seek/Indeed only as fallback.'
              : 'No careers page found. Add SERPER_API_KEY in .env for job-board fallback search.')
            : '<span class="inline-spinner"></span>Scanning careers page, ATS boards, and company website…'}</div>`;
    return `
      <div class="detail-section jobs-section">
        <div class="detail-label">
          <span>Careers &amp; open roles (${jobs.length})</span>
          <button class="mini-btn" onclick="App.refreshJobs('${c.id}')">${ic('refresh', 12)}Scan jobs</button>
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
        <div class="deep-scan-radar">
          <div class="radar-ring radar-ring-1"></div>
          <div class="radar-ring radar-ring-2"></div>
          <div class="radar-sweep"></div>
          <div class="radar-blip"></div>
          <div class="radar-core"></div>
        </div>
        <div class="deep-scan-title">
          <span class="deep-scan-eyebrow">Deep-scanning</span>
          <span class="deep-scan-host">${escapeHtml(host)}<span class="ds-cursor"></span></span>
        </div>
        <div class="deep-scan-sub">Careers page · ATS APIs · JobAdder · team · verified LinkedIn · contact…</div>
        <ul class="deep-scan-tasks">
          <li style="--i:0"><span class="ds-icon"></span> Extracting careers email &amp; contact details</li>
          <li style="--i:1"><span class="ds-icon"></span> Finding team members &amp; LinkedIn profiles</li>
          <li style="--i:2"><span class="ds-icon"></span> Looking up social profiles</li>
          <li style="--i:3"><span class="ds-icon"></span> Scanning website + job boards for open roles</li>
        </ul>
        <div class="deep-scan-progress"><div class="deep-scan-progress-bar"></div></div>
        <a class="deep-scan-link" href="${escapeAttr(c.website)}" target="_blank" rel="noopener">Open website in new tab ${ic('chevron-right', 12, false)}</a>
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
        headers: AuthGate.authHeaders(),
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
        headers: AuthGate.authHeaders(),
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
    // Primary: "can I do this job / is it still open" facts — always visible.
    const meta = [];
    if (j.location)     meta.push(`<span>${ic('pin', 12)}${escapeHtml(j.location)}</span>`);
    if (j.remote)       meta.push(`<span style="color:var(--accent2)">${ic('globe', 12)}Remote</span>`);
    if (j.salary)       meta.push(`<span>${ic('dollar', 12)}${escapeHtml(j.salary)}</span>`);
    if (j.closes_at) {
      const days = Math.ceil((j.closes_at - Date.now()) / 86400000);
      const cls = days < 0 ? 'closed' : days <= 7 ? 'urgent' : '';
      const txt = days < 0 ? `closed ${-days}d ago` : `closes in ${days}d`;
      meta.push(`<span class="deadline ${cls}" title="Deadline ${new Date(j.closes_at).toLocaleDateString()}">${ic('clock', 12)}${txt}</span>`);
    }
    if (j.freshness_label === 'new' && j.hidden_market_label === 'likely-open') {
      meta.push(`<span style="color:var(--green)" title="First time seen, no repost history">${ic('check', 12)}Freshly posted</span>`);
    }
    if (j.visa_flag === 'sponsorship-available') {
      meta.push(`<span style="color:var(--green)">${ic('check', 12)}Sponsorship mentioned</span>`);
    }

    // Secondary: context, not decision-critical — smaller/muted line. The
    // confidence badge already names the source for board listings (e.g.
    // "Job board · Seek"), so a separate raw job-source chip would just
    // repeat the same fact.
    const secondary = [];
    if (j.job_type)     secondary.push(`<span>${ic('briefcase', 12)}${escapeHtml(j.job_type)}</span>`);
    if (j.department)   secondary.push(`<span>${ic('price-tag', 12)}${escapeHtml(j.department)}</span>`);
    if (j.posted_at)    secondary.push(`<span title="Posted ${new Date(j.posted_at).toLocaleDateString()}">${ic('calendar', 12)}Posted ${timeAgo(j.posted_at)}</span>`);
    const trust = jobTrustLabel(j.source, j);

    const desc = j.description
      ? `<div class="job-desc">${escapeHtml(truncate(j.description, 280))}</div>`
      : '';

    const titleHtml = j.url
      ? `<a href="${escapeAttr(j.url)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>`
      : escapeHtml(j.title);

    // Flags: anything worth reading before applying, collapsed behind one
    // summary instead of stacking full-width warning blocks per issue.
    const flags = [];
    if (j.looks_suspicious) {
      flags.push(`This posting has red flags — ${(j.quality_flags || []).map(escapeHtml).join('; ') || 'looks unusual'}. Verify carefully before applying or sharing any details.`);
    }
    // Only warn when it's actually relevant to THIS user — someone who's a
    // citizen/PR (or didn't set this in their profile yet) gets no warning
    // even on a citizens-only posting, since it doesn't affect them.
    const needsVisa = ['visa-full', 'visa-limited', 'visa-sponsorship', 'working-holiday'].includes(profile.workRights);
    if (needsVisa && (j.visa_flag === 'citizens-only' || j.visa_flag === 'clearance-required')) {
      flags.push(`${j.visa_flag === 'clearance-required' ? 'Requires a security clearance, which effectively means citizens/PR only' : 'Requires Australian citizenship or permanent residency'} — based on your profile, you may not be eligible for this role.`);
    }
    if (j.hidden_market_label === 'possibly-filled') {
      flags.push(`${j.hidden_market_reason || `Reposted ${j.repost_count} times`} — this role may already be informally filled.`);
    }
    const flagsBlock = flags.length
      ? `<details class="job-flags"><summary>${ic('warning', 12)}${flags.length} flag${flags.length > 1 ? 's' : ''} — check before applying</summary>${flags.map(f => `<div class="job-suspicious-warning">${ic('warning', 13)}${f}</div>`).join('')}</details>`
      : '';

    return `
      <div class="job-row ${j.applied ? 'applied' : ''} ${j.looks_suspicious ? 'is-suspicious' : ''}">
        <input type="checkbox" class="job-checkbox" ${j.applied ? 'checked' : ''} onchange="App.toggleJobApplied(${j.id}, this.checked)" />
        <div class="job-body">
          <div class="job-title">${titleHtml}</div>
          <div class="job-meta">${meta.join('')}</div>
          ${secondary.length || trust ? `<div class="job-meta-secondary">${secondary.join('')}${trust}</div>` : ''}
          ${flagsBlock}
          ${desc}
          ${j.url ? `<a class="job-apply-link" href="${escapeAttr(j.url)}" target="_blank" rel="noopener">Open posting ${ic('chevron-right', 12, false)}</a>` : ''}
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
    return `<div class="match-banner">${ic('logo', 14)}<strong>Good match for your skills</strong> — likely needs ${opps.slice(0, 2).join(' / ')}.</div>`;
  }

  // AI fit score is opt-in per company (costs a real API call) rather than
  // running automatically for everything in a scan — this renders the ask
  // button, and checkAiFit() below swaps in the result in place.
  function renderAiFitSection(c) {
    return `
      <div class="detail-section ai-fit-section" id="aiFitSection">
        <div class="detail-label"><span>${ic('ai', 13)}AI fit check</span></div>
        <button class="btn btn-outline ai-fit-btn" onclick="App.checkAiFit('${escapeAttr(c.id)}')">
          Check how well this actually fits your profile
        </button>
      </div>`;
  }

  async function checkAiFit(companyId) {
    const section = document.getElementById('aiFitSection');
    if (!section) return;
    section.innerHTML = `
      <div class="detail-label"><span>${ic('ai', 13)}AI fit check</span></div>
      <div class="empty-hint"><span class="inline-spinner"></span>Reading the role and your profile…</div>`;
    try {
      const resp = await fetch('/api/ai/fit-score', {
        method: 'POST',
        headers: AuthGate.authHeaders(),
        body: JSON.stringify({ company_id: companyId }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.available) {
        section.innerHTML = `
          <div class="detail-label"><span>${ic('ai', 13)}AI fit check</span></div>
          <div class="empty-hint">${escapeHtml(data.message || data.error || 'Could not check fit right now.')}</div>`;
        return;
      }
      const tier = data.score >= 70 ? 'good' : data.score >= 40 ? 'ok' : 'low';
      section.innerHTML = `
        <div class="detail-label"><span>${ic('ai', 13)}AI fit check</span></div>
        <div class="ai-fit-result ${tier}">
          <div class="ai-fit-score">${data.score}<span>/100</span></div>
          <div class="ai-fit-reason">${escapeHtml(data.reason)}</div>
        </div>`;
    } catch (err) {
      section.innerHTML = `
        <div class="detail-label"><span>${ic('ai', 13)}AI fit check</span></div>
        <div class="empty-hint">Could not reach the server — try again.</div>`;
    }
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
    // Address the identified hiring contact by first name when we have one
    // — "Hi [Company] team" is the fallback when no contact was found.
    const contact = c.profile?.hiring_contact;
    if (contact?.name) return contact.name.split(' ')[0];
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
        <br><button class="btn btn-primary" onclick="App.openProfile()">${ic('person', 13)}Set profile</button>
      </div>`;
    }

    const cid = escapeAttr(c.id);
    const contact = c.profile?.hiring_contact || null;
    const verified = isVerifiedEmail(c);
    const hasEmail = !!c.email || !!contact?.email;
    const subject = buildOutreachSubject(c);
    const body = buildOutreachBody(c);
    const variants = _outreachVariants[c.id] || [];

    const hiringContactHTML = contact ? `
      <div class="hiring-contact-card">
        <div class="hiring-contact-main">
          <span class="hiring-contact-name">${escapeHtml(contact.name)}</span>
          ${contact.title ? `<span class="hiring-contact-title">${escapeHtml(contact.title)}</span>` : ''}
        </div>
        <div class="hiring-contact-reason">${escapeHtml(contact.reason)}</div>
        <div class="hiring-contact-links">
          ${contact.email ? `<a href="mailto:${escapeAttr(contact.email)}">${ic('email', 11)}${escapeHtml(contact.email)}</a>` : ''}
          ${contact.linkedin_verified && contact.linkedin_url ? `<a href="${escapeAttr(contact.linkedin_url)}" target="_blank" rel="noopener">${ic('external-link', 11, false)}LinkedIn</a>` : ''}
        </div>
      </div>` : '';

    const toStatus = verified
      ? `<span class="email-ok">${ic('check', 12)}Verified</span>`
      : hasEmail
        ? '<span class="email-warn">Not verified</span>'
        : '<span class="email-warn">Not found — type one in, or enrich website first</span>';

    const verifyBtn = hasEmail
      ? `<button type="button" class="mini-btn" id="verifyEmailBtn-${cid}" onclick="App.verifyCompanyEmail('${cid}')">${verified ? ic('refresh', 12) + 'Re-verify email' : ic('search', 12) + 'Verify email'}</button>`
      : '';

    const variantCards = variants.length
      ? variants.map((v, i) => `
          <button type="button" class="outreach-variant" onclick="App.applyOutreachVariant('${cid}', ${i})">
            <span class="ov-label">${escapeHtml(v.label || v.tone)}</span>
            <span class="ov-hint">${escapeHtml(v.hint || v.source || '')}</span>
            <span class="ov-subj">${escapeHtml(v.subject || '')}</span>
          </button>`).join('')
      : '';

    const hasSendingAccount = !!profile.emailAccount?.configured;
    const canSend = hasEmail && hasSendingAccount;
    const sendHint = !hasSendingAccount
      ? 'Add your sending email account in Profile → Email account before you can send'
      : !hasEmail
        ? 'Type an email address above before sending'
        : '';

    return `
      <div class="outreach-section" id="outreachSection-${cid}">
        ${hiringContactHTML}
        <div class="outreach-top">
          <label class="outreach-field-label" style="margin:0">To ${toStatus}</label>
          ${verifyBtn}
        </div>
        <input type="email" class="outreach-subject-input" id="outreachTo-${cid}" value="${escapeAttr(contact?.email || c.email || '')}"
          placeholder="careers@company.com" oninput="App.onOutreachToInput('${cid}')" />
        <div class="outreach-verify-note" id="outreachVerifyNote-${cid}"></div>

        <div class="outreach-ai-bar">
          <span class="outreach-ai-title">${ic('sparkles', 13)}Quick creative drafts</span>
          <button type="button" class="mini-btn" id="genEmailBtn-${cid}" onclick="App.generateOutreachEmails('${cid}')">
            ${state.hasOpenAiKey ? 'Generate with AI' : 'Generate options'}
          </button>
        </div>
        <div class="outreach-variants" id="outreachVariants-${cid}">${variantCards}</div>

        <label class="outreach-field-label">Subject</label>
        <input type="text" class="outreach-subject-input" id="outreachSubject-${cid}" value="${escapeAttr(subject)}" />

        <label class="outreach-field-label">Message</label>
        <textarea class="outreach-body" id="outreachBody-${cid}">${escapeHtml(body)}</textarea>

        <div class="outreach-attach-row">
          <label class="toggle-row"><input type="checkbox" id="attachResume-${cid}" checked /><div class="toggle-box">${ic('check', 12, false)}</div><span>Attach resume (PDF)</span></label>
          <label class="toggle-row"><input type="checkbox" id="attachCoverLetter-${cid}" checked /><div class="toggle-box">${ic('check', 12, false)}</div><span>Attach cover letter (PDF)</span></label>
        </div>

        <div class="outreach-actions">
          <button type="button" class="btn btn-primary" onclick="App.copyOutreach('${cid}')">${ic('admin', 13)}Copy</button>
          <button type="button" class="btn btn-accent-send" id="sendEmailBtn-${cid}"
            onclick="App.sendOutreachEmail('${cid}')"
            ${canSend ? '' : `disabled title="${escapeAttr(sendHint)}"`}>
            ${ic('email', 13)}Send email
          </button>
          <button type="button" class="btn btn-outline" id="mailAppBtn-${cid}" onclick="App.openMailApp('${cid}')" ${hasEmail ? '' : 'disabled'}>
            ${ic('external-link', 13)}Mail app &amp; mark applied
          </button>
        </div>
        <div class="outreach-actions">
          <button type="button" class="btn btn-outline" id="resumeBtn-${cid}" onclick="App.downloadResume()">
            ${ic('folder', 13)}Resume (PDF)
          </button>
          <button type="button" class="btn btn-outline" id="coverLetterBtn-${cid}" onclick="App.downloadCoverLetter('${cid}')">
            ${ic('folder', 13)}Cover letter (PDF)
          </button>
        </div>
        ${sendHint && !canSend ? `<div class="outreach-send-hint">${escapeHtml(sendHint)}</div>` : ''}
        ${!hasEmail && c.careers_url ? `
        <div class="outreach-careers-fallback">
          No email on file — apply straight through their careers page instead:
          <a class="btn btn-primary" href="${escapeAttr(c.careers_url)}" target="_blank" rel="noopener"
             onclick="App.markAppliedFromLinkClick('${cid}')">${ic('external-link', 13)}Open careers page &amp; mark applied</a>
        </div>` : ''}
      </div>`;
  }

  // "Assisted apply, one click, from here only" — clicking the mailto: /
  // careers-page link IS the apply action once you've reviewed the draft in
  // the app, so mark it applied at the same time instead of requiring a
  // second, separate manual toggle afterwards.
  function markAppliedFromLinkClick(id) {
    const c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    if (c && c.status !== 'applied') {
      toggleStatus(id, 'applied');
      toast('Marked as applied', 'success');
    }
  }

  function getOutreachFields(id) {
    return {
      to: document.getElementById('outreachTo-' + id)?.value?.trim() || '',
      subject: document.getElementById('outreachSubject-' + id)?.value?.trim() || '',
      body: document.getElementById('outreachBody-' + id)?.value?.trim() || '',
    };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Live-enables Send as soon as the To field holds a plausible address —
  // it no longer needs the auto-detected email specifically or a passed
  // verification check, since typing one in here is an explicit user
  // override (server-side trusts it the same way a manually-clicked mailto
  // link already implicitly does).
  function onOutreachToInput(id) {
    const btn = document.getElementById('sendEmailBtn-' + id);
    const mailBtn = document.getElementById('mailAppBtn-' + id);
    const to = document.getElementById('outreachTo-' + id)?.value?.trim() || '';
    const looksValid = EMAIL_RE.test(to);
    if (mailBtn) mailBtn.disabled = !looksValid;
    if (btn) {
      const hasSendingAccount = !!profile.emailAccount?.configured;
      btn.disabled = !(looksValid && hasSendingAccount);
      btn.title = !hasSendingAccount ? 'Add your sending email account in Profile → Email account before you can send'
        : !looksValid ? 'Type an email address above before sending' : '';
    }
  }

  function openMailApp(id) {
    const { to, subject } = getOutreachFields(id);
    if (!EMAIL_RE.test(to)) { toast('Type a valid email address first', 'error'); return; }
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`;
    markAppliedFromLinkClick(id);
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
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="inline-spinner"></span>Verifying…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/verify-email`, { method: 'POST', headers: AuthGate.authHeaders() });
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
        btn.innerHTML = isVerifiedEmail(c || {}) ? `${ic('refresh', 12)}Re-verify email` : `${ic('search', 12)}Verify email`;
      }
    }
  }

  async function generateOutreachEmails(id) {
    const btn = document.getElementById('genEmailBtn-' + id);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="inline-spinner"></span>Generating…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/generate-emails`, {
        method: 'POST',
        headers: AuthGate.authHeaders(),
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
    const { to, subject, body } = getOutreachFields(id);
    if (!EMAIL_RE.test(to)) {
      toast('Type a valid email address to send to', 'error');
      return;
    }
    if (!profile.emailAccount?.configured) {
      toast('Add your sending email account in Profile → Email account', 'error');
      openProfile();
      return;
    }
    if (!subject || !body) {
      toast('Subject and message required', 'error');
      return;
    }
    const attachResume = document.getElementById('attachResume-' + id)?.checked ?? true;
    const attachCoverLetter = document.getElementById('attachCoverLetter-' + id)?.checked ?? true;
    const attachNote = [attachResume && 'resume', attachCoverLetter && 'cover letter'].filter(Boolean).join(' + ');
    if (!window.confirm(`Send email to ${to}?\n\nSubject: ${subject}${attachNote ? `\nAttaching: ${attachNote}` : ''}`)) return;

    const btn = document.getElementById('sendEmailBtn-' + id);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="inline-spinner"></span>Sending…'; }
    try {
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/send-email`, {
        method: 'POST',
        headers: AuthGate.authHeaders(),
        body: JSON.stringify({
          to,
          subject,
          body,
          fromName: profile.name || profile.signature,
          attachResume,
          attachCoverLetter,
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
        const stillValid = EMAIL_RE.test(document.getElementById('outreachTo-' + id)?.value?.trim() || '');
        btn.disabled = !(stillValid && profile.emailAccount?.configured);
        btn.innerHTML = `${ic('email', 13)}Send email`;
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

  // Address, LinkedIn/employees, and a mailto link all already live in
  // Contact / Company links / People — this only holds what's genuinely
  // NOT shown anywhere else: map actions, a general careers search, and
  // stats not covered elsewhere.
  function renderExplore(c) {
    const nameQ = encodeURIComponent(c.name);
    const addrQ = encodeURIComponent([c.name, c.address].filter(Boolean).join(' '));
    const links = [
      { icon: 'map-nav', label: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${addrQ}` },
      { icon: 'automotive', label: 'Directions', url: `https://www.google.com/maps/dir/?api=1&destination=${addrQ}` },
      { icon: 'search', label: 'Search on Google', url: `https://www.google.com/search?q=${nameQ}+careers` },
    ];

    const stats = [];
    if (typeof c.rating === 'number') stats.push(`<span>${ic('star')}${c.rating.toFixed(1)} (Google)</span>`);
    if (c.enriched_at) {
      stats.push(`<span title="${new Date(c.enriched_at).toLocaleString()}">${ic('clock')}Enriched ${timeAgo(c.enriched_at)}</span>`);
    } else if (c.website) {
      stats.push(`<span style="color:var(--accent2);display:inline-flex;align-items:center"><span class="inline-spinner"></span>Fetching website &amp; jobs… (≈10s)</span>`);
    }
    const totalJobs   = (c.jobs || []).length;
    const appliedJobs = (c.jobs || []).filter(j => j.applied).length;
    if (totalJobs) stats.push(`<span>${ic('admin')}${appliedJobs}/${totalJobs} jobs applied</span>`);

    return `
      <div class="explore-stats">${stats.join('')}</div>
      <div class="explore-links">
        ${links.map(l => `<a class="explore-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${ic(l.icon)}${escapeHtml(l.label)}</a>`).join('')}
      </div>`;
  }

  // ---- detail panel -------------------------------------------------------

  async function openDetail(id) {
    let c = state.companies.find(x => String(x.id) === String(id))
      || state.pipelineCompanies.find(x => String(x.id) === String(id));
    if (!c) {
      try {
        c = await fetch(`/api/companies/${encodeURIComponent(id)}`, { headers: AuthGate.authHeaders() }).then(r => {
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
      document.getElementById('detailTabs').classList.add('hidden');
      document.getElementById('detailBody').innerHTML = renderDeepScanSkeleton(c);
      document.getElementById('detailPanel').classList.add('open');
      document.getElementById('detailBackdrop').classList.add('show');
      renderCompanies();
      lazyEnrich(c.id, { depth: 'full' });
      return;
    }

    const trustBanner = buildTrustBanner(c);

    const emailIcon = ic('email', 13, false);
    const emailRow = c.email
      ? (isVerifiedEmail(c)
        ? `<div class="contact-row"><span class="contact-icon">${emailIcon}</span><a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a><button class="copy-btn" onclick="App.copy('${escapeAttr(c.email)}')">Copy</button></div><div class="trust-note">${emailTrustNote(c)}</div>`
        : `<div class="contact-row unverified"><span class="contact-icon">${emailIcon}</span><span>${escapeHtml(c.email)}</span><button class="copy-btn" onclick="App.copy('${escapeAttr(c.email)}')">Copy</button></div><div class="trust-note warn">${escapeHtml(emailTrustNote(c))}</div>`)
      : `<div class="contact-row missing"><span class="contact-icon">${emailIcon}</span>No careers email found on their website</div>`;

    const phoneRow = c.phone
      ? `<div class="contact-row"><span class="contact-icon">${ic('phone', 13, false)}</span><a href="tel:${escapeAttr(c.phone)}">${escapeHtml(c.phone)}</a><button class="copy-btn" onclick="App.copy('${escapeAttr(c.phone)}')">Copy</button></div>`
      : '';

    const addressBit = c.address ? `<div class="contact-row"><span class="contact-icon">${ic('pin', 13, false)}</span>${escapeHtml(c.address)}</div>` : '';

    const otherEmails = (c.all_emails || []).filter(e => isPlausibleExtraEmail(e, c));
    const otherEmailsRow = otherEmails.length ? `
      <div class="detail-section">
        <div class="detail-label">Other emails found</div>
        ${otherEmails.slice(0, 8).map(e => `
          <div class="contact-row">
            <span class="contact-icon">${emailIcon}</span>
            <a href="mailto:${escapeAttr(e)}">${escapeHtml(e)}</a>
            <button class="copy-btn" onclick="App.copy('${escapeAttr(e)}')">Copy</button>
          </div>`).join('')}
      </div>` : '';

    // Social profiles — moved to Company links section when profile exists.
    const socialRow = (!c.profile?.links?.length && (c.socials && Object.keys(c.socials).length)) ? (() => {
      const socials = c.socials || {};
      const socialIconNames = { linkedin: 'briefcase', instagram: 'creative', facebook: 'thumb', tiktok: 'music-note' };
      const socialTextIcons = { twitter: '𝕏', youtube: '▶' };
      const socialChips = Object.entries(socials).map(([k, url]) => {
        const icon = socialIconNames[k] ? ic(socialIconNames[k]) : (socialTextIcons[k] || ic('link-chain'));
        return `<a class="social-chip" href="${escapeAttr(url)}" target="_blank" rel="noopener">${icon}${escapeHtml(k.charAt(0).toUpperCase() + k.slice(1))}</a>`;
      }).join('');
      return `
      <div class="detail-section">
        <div class="detail-label">Social profiles</div>
        <div class="socials-row">${socialChips}</div>
      </div>`;
    })() : '';

    const companyLinksSection = renderCompanyLinksSection(c);

    // Description (from meta description / og:description / page text)
    const descSection = c.description ? `
      <div class="detail-section">
        <div class="detail-label">About</div>
        <div class="about-text">${escapeHtml(c.description)}</div>
      </div>` : '';

    // Team section: names + titles + LinkedIn links (resolved or searchable).
    const teamSection = renderTeamSection(c);
    const jobsSection = renderJobsSection(c);

    const stars = [1, 2, 3, 4, 5].map(i => `<span class="star ${c.user_rating >= i ? 'lit' : ''}" onclick="App.setRating('${c.id}', ${i})">${ic('star', 15, false)}</span>`).join('');

    const detailTabs = document.getElementById('detailTabs');
    detailTabs.classList.remove('hidden');
    detailTabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'overview'));
    document.getElementById('detailBody').innerHTML = `
      <div class="detail-tab-panel" data-tab-panel="overview">
        ${trustBanner}
        ${renderMatchBanner(c)}
        ${state.hasOpenAiKey ? renderAiFitSection(c) : ''}
        ${descSection}
        <div class="detail-section">
          <div class="detail-label">
            <span>Contact</span>
            ${c.website ? `<button class="mini-btn" onclick="App.reVerifyCompany('${escapeAttr(c.id)}')">${ic('refresh', 12)}Re-scan website</button>` : ''}
          </div>
          ${emailRow}
          ${phoneRow}
          ${addressBit}
        </div>
        ${companyLinksSection}
        ${teamSection}
        ${socialRow}
        ${otherEmailsRow}
        <div class="detail-section">
          <div class="detail-label">Explore</div>
          ${renderExplore(c)}
        </div>
      </div>
      <div class="detail-tab-panel hidden" data-tab-panel="jobs">
        ${jobsSection}
      </div>
      <div class="detail-tab-panel hidden" data-tab-panel="outreach">
        <div class="detail-section">
          <div class="detail-label">Outreach email</div>
          ${renderOutreach(c)}
        </div>
      </div>
      <div class="detail-tab-panel hidden" data-tab-panel="tracking">
        <div class="detail-section">
          <div class="detail-label">Your tracking</div>
          <div class="stage-control">
            ${['interested', 'applied', 'interviewing', 'offer', 'rejected'].map(stage => `
              <button class="stage-btn stage-${stage} ${c.status === stage ? 'active' : ''}" onclick="App.toggleStatus('${c.id}', '${stage}')">
                ${STAGE_LABELS[stage]}
              </button>
            `).join('')}
          </div>
          <div class="rating-row">${stars}</div>
          <textarea class="notes-area" placeholder="Add notes about this company…" oninput="App.saveNotes('${c.id}', this.value)">${escapeHtml(c.notes || '')}</textarea>
        </div>
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
    document.getElementById('detailTabs').classList.add('hidden');
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
        { method: 'POST', headers: AuthGate.authHeaders() },
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
        fetch(`/api/companies/${encodeURIComponent(c.id)}/enrich?depth=contact`, { method: 'POST', headers: AuthGate.authHeaders() })
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

  function switchDetailTab(tab) {
    document.getElementById('detailTabs').querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tabPanel !== tab));
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
      const resp = await fetch(`/api/companies/${encodeURIComponent(id)}/refresh-jobs`, { method: 'POST', headers: AuthGate.authHeaders() });
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
      headers: AuthGate.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    return resp.json();
  }

  async function patchJob(id, body) {
    const resp = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: AuthGate.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
    return resp.json();
  }

  // ---- filters / tabs -----------------------------------------------------

  const LIST_PREFS_KEY = 'areahunt.listPrefs.v1';

  function loadListPrefs() {
    try {
      const raw = localStorage.getItem(LIST_PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.sortBy === 'string') state.sortBy = p.sortBy;
      if (p.quickFilters && typeof p.quickFilters === 'object') {
        for (const k of Object.keys(state.quickFilters)) {
          state.quickFilters[k] = !!p.quickFilters[k];
        }
      }
      if (typeof p.pipelineSort === 'string') state.pipelineSort = p.pipelineSort;
    } catch {}
  }

  function saveListPrefs() {
    try {
      localStorage.setItem(LIST_PREFS_KEY, JSON.stringify({
        sortBy: state.sortBy,
        quickFilters: state.quickFilters,
        pipelineSort: state.pipelineSort,
      }));
    } catch {}
  }

  let _listControlsBound = false;
  function initListControls() {
    if (_listControlsBound) return;
    loadListPrefs();
    const searchEl = document.getElementById('companySearch');
    const clearEl = document.getElementById('clearCompanySearch');
    const sortEl = document.getElementById('sortSelect');
    const quickEl = document.getElementById('quickFilters');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        state.search = searchEl.value;
        renderCompanies();
        addMarkers();
      });
    }
    if (clearEl) {
      clearEl.addEventListener('click', () => {
        state.search = '';
        if (searchEl) searchEl.value = '';
        searchEl?.focus();
        renderCompanies(true);
        addMarkers();
      });
    }
    if (sortEl) {
      sortEl.value = state.sortBy;
      sortEl.addEventListener('change', () => {
        state.sortBy = sortEl.value;
        saveListPrefs();
        renderCompanies(true);
      });
    }
    if (quickEl) {
      quickEl.querySelectorAll('.quick-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.qf;
          state.quickFilters[key] = !state.quickFilters[key];
          saveListPrefs();
          renderCompanies(true);
          addMarkers();
        });
      });
    }
    const pipeSearch = document.getElementById('pipelineSearch');
    const pipeClear = document.getElementById('clearPipelineSearch');
    const pipeSort = document.getElementById('pipelineSortSelect');
    if (pipeSearch) {
      pipeSearch.addEventListener('input', () => {
        state.pipelineSearch = pipeSearch.value;
        document.getElementById('pipelineSearchWrap')?.classList.toggle('has-text', !!pipeSearch.value.trim());
        renderPipelineList();
      });
    }
    if (pipeClear) {
      pipeClear.addEventListener('click', () => {
        state.pipelineSearch = '';
        if (pipeSearch) pipeSearch.value = '';
        document.getElementById('pipelineSearchWrap')?.classList.remove('has-text');
        renderPipelineList();
      });
    }
    if (pipeSort) {
      pipeSort.value = state.pipelineSort;
      pipeSort.addEventListener('change', () => {
        state.pipelineSort = pipeSort.value;
        saveListPrefs();
        renderPipelineList();
      });
    }
    _listControlsBound = true;
  }

  function syncToolbarState() {
    const wrap = document.getElementById('listSearchWrap');
    if (wrap) wrap.classList.toggle('has-text', !!state.search.trim());
    const quickEl = document.getElementById('quickFilters');
    if (quickEl) {
      quickEl.querySelectorAll('.quick-chip').forEach(btn => {
        btn.classList.toggle('active', !!state.quickFilters[btn.dataset.qf]);
      });
    }
    const sortEl = document.getElementById('sortSelect');
    if (sortEl && sortEl.value !== state.sortBy) sortEl.value = state.sortBy;
  }

  function resetListControls() {
    state.search = '';
    state.quickFilters = { roles: false, verified: false, email: false, team: false, match: false };
    const searchEl = document.getElementById('companySearch');
    if (searchEl) searchEl.value = '';
    renderCompanies(true);
  }

  function renderIndustryFilters() {
    const el = document.getElementById('industryFilters');
    if (!el || typeof AreaHuntIndustries === 'undefined') return;
    el.innerHTML = AreaHuntIndustries.OPTIONS.map(o => {
      const active = state.activeCats.includes(o.id);
      const icon = AreaHuntIndustries.iconSvg(o.icon, 12);
      const label = o.id === 'all' ? 'All' : escapeHtml(o.label);
      return `<button type="button" class="filter-tag ${active ? 'active' : ''}" data-cat="${o.id}">${icon}${label}</button>`;
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

  // ---- job-hunt insights (real data only — see insightsService.js) --------

  async function loadInsights() {
    const el = document.getElementById('pipelineInsights');
    if (!el) return;
    el.innerHTML = `<div class="insights-loading"><span class="inline-spinner"></span>Analysing your saved companies and job postings…</div>`;
    try {
      const data = await fetch('/api/insights', { headers: AuthGate.authHeaders() }).then(r => r.json());
      renderInsights(data);
    } catch {
      el.innerHTML = `<div class="insights-loading">Could not load insights — try again.</div>`;
    }
  }

  function insightBar(label, value, max, color) {
    const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2;
    return `
      <div class="insight-bar-row">
        <div class="insight-bar-label">${escapeHtml(label)}</div>
        <div class="insight-bar-track"><div class="insight-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="insight-bar-value">${value > 0 ? '+' : ''}${Math.round(value * 100)}%</div>
      </div>`;
  }

  function renderInsights(data) {
    const el = document.getElementById('pipelineInsights');
    if (!el) return;
    const { ranked, gaps } = data;

    let rankedHtml;
    if (!ranked.companies.length) {
      rankedHtml = `<div class="insights-empty">Save a few companies to start seeing which ones you're likely to be the best fit for.</div>`;
    } else if (!ranked.ready) {
      rankedHtml = `<div class="insights-empty">Not enough history yet — save, skip, or apply to a few more companies (at least ${ranked.minSamples} of a kind) and this'll start showing real signal instead of a flat list.</div>`;
    } else {
      const top = ranked.companies.slice(0, 10);
      const maxAbs = Math.max(0.1, ...top.map(c => Math.abs(c.learned_score)));
      rankedHtml = top.map(c => insightBar(
        c.name, c.learned_score, maxAbs,
        c.learned_score >= 0 ? 'var(--green)' : 'var(--red)',
      )).join('');
      rankedHtml = `<div class="insight-bars">${rankedHtml}</div>
        <p class="insights-hint">Based on the pattern in your own save/apply/skip history — not a generic score. A positive number means companies like this tend to be ones you follow through on.</p>`;
    }

    let gapsHtml;
    if (!gaps.ready) {
      gapsHtml = `<div class="insights-empty">${escapeHtml(gaps.reason === 'save or apply to a few companies first' ? 'Save or apply to a few companies with job postings first — this looks at what those postings actually ask for.' : 'None of your saved companies have job postings scraped yet — try "Re-scan website" on one, or check back after a deep scan finishes.')}</div>`;
    } else if (!gaps.gaps.length) {
      gapsHtml = `<div class="insights-empty">Nothing stands out yet — across ${gaps.jobsAnalyzed} job posting${gaps.jobsAnalyzed === 1 ? '' : 's'} from your ${gaps.companiesAnalyzed} saved/applied compan${gaps.companiesAnalyzed === 1 ? 'y' : 'ies'}, your profile already covers what keeps coming up.</div>`;
    } else {
      gapsHtml = gaps.gaps.map(g => `
        <div class="gap-card">
          <div class="gap-card-title">${escapeHtml(g.label)}</div>
          <div class="gap-card-meta">Mentioned in ${g.mentionedIn} of ${g.outOf} of your saved/applied job postings — not reflected in your profile yet.</div>
          <div class="gap-card-suggestion">${escapeHtml(g.suggestion)}</div>
        </div>`).join('');
    }

    el.innerHTML = `
      <div class="insights-section">
        <h3>Which saved companies are you most likely to follow through on?</h3>
        ${rankedHtml}
      </div>
      <div class="insights-section">
        <h3>What keeps coming up that isn't in your profile yet</h3>
        ${gapsHtml}
      </div>`;
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
    document.getElementById('pipeTabInsights')?.classList.toggle('active', tab === 'insights');
    document.getElementById('pipelineList')?.classList.toggle('hidden', tab === 'insights');
    document.getElementById('pipelineInsights')?.classList.toggle('hidden', tab !== 'insights');
    document.getElementById('pipelineSearchWrap')?.classList.toggle('hidden', tab === 'insights');
    document.getElementById('pipelineSortSelect')?.parentElement?.classList.toggle('hidden', tab === 'insights');
    if (silent) return;
    if (tab === 'insights') loadInsights();
    else loadPipelineList(tab === 'interested' ? 'interested' : 'applied');
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

  // Inline icon for text/badge contexts (replaces emoji) — references the
  // sprite in index.html. `.ui-icon` adds a small right margin so it reads
  // naturally before a text label; pass gap:false for icon-only buttons.
  function ic(name, size = 13, gap = true) {
    return `<svg class="ui-icon${gap ? '' : ' no-gap'}" width="${size}" height="${size}"><use href="#icon-${name}"></use></svg>`;
  }

  // Scraped text (LinkedIn/Google snippets) is free text, not structured data —
  // cut at the nearest word boundary instead of mid-word so truncation reads
  // as intentional rather than broken.
  function truncate(s, max) {
    const str = String(s || '').trim();
    if (str.length <= max) return str;
    const cut = str.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
  }

  return {
    init,
    toggleDraw, scanArea, clearAll,
    filterCat,
    openScanPage, openPipelinePage, switchPipelineTab,
    markAreaDone, saveArea,
    openDetail, closeDetail, switchDetailTab,
    toggleStatus, toggleJobApplied, setRating, saveNotes, refreshJobs,
    copy, copyOutreach,
    verifyCompanyEmail, generateOutreachEmails, applyOutreachVariant, sendOutreachEmail,
    onOutreachToInput, openMailApp,
    openProfile, closeProfile, closeProfileBackdrop, saveProfile, logout, deleteAccount, resendVerification,
    toggleAlerts, toggleTrainingConsent, toggleTheme,
    downloadResume, downloadCoverLetter,
    resolveTeamLinkedIn, discoverPeople, reVerifyCompany, toggleMapMode,
    openAccountMenu, resetListControls, loadMoreCompanies,
    checkAiFit, markAppliedFromLinkClick,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
