(function () {
  const TOKEN_KEY = 'areahunt.admin.token.v1';
  let token = null;
  let activeTab = 'overview';
  let usersCache = [];

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtNum(x) { return x == null ? '—' : Number(x).toLocaleString(); }
  function fmtPct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString() : '—'; }
  function fmtDateTime(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }

  function authHeaders() {
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  function saveToken(t) {
    token = t;
    try { localStorage.setItem(TOKEN_KEY, t); } catch {}
  }
  function loadToken() {
    try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }
    return token;
  }
  function clearToken() {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  function showLogin(message) {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('adminShell').classList.add('hidden');
    const err = document.getElementById('loginError');
    if (message) {
      err.textContent = message;
      err.style.display = '';
    } else {
      err.style.display = 'none';
    }
  }

  function showShell() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminShell').classList.remove('hidden');
    switchTab(activeTab);
  }

  async function login() {
    const password = document.getElementById('adminPassword').value;
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const resp = await fetch('/api/admin-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Login failed');
      saveToken(data.token);
      document.getElementById('adminPassword').value = '';
      showShell();
    } catch (err) {
      showLogin(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  function logout() {
    clearToken();
    showLogin();
  }

  async function boot() {
    document.getElementById('adminPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });
    if (!loadToken()) { showLogin(); return; }
    const resp = await fetch('/api/admin/stats', { headers: authHeaders() });
    if (resp.status === 401) { clearToken(); showLogin(); return; }
    showShell();
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.admin-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.admin-tab-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById(`panel-${tab}`).classList.remove('hidden');
    if (tab === 'overview') loadOverview();
    if (tab === 'users') loadUsers();
    if (tab === 'settings') loadSettings();
  }

  // ---- overview -------------------------------------------------------

  let overviewDays = 30;

  function industryLabel(cat) {
    if (cat === 'other') return 'Other';
    const opt = window.AreaHuntIndustries?.BY_ID?.[cat];
    if (opt) return opt.label;
    return cat.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function dataQualityRows(dq) {
    const pct = (n) => dq.total ? Math.round((n / dq.total) * 100) : 0;
    const rows = [
      ['Has an email on file', dq.with_email],
      ['Verified email', dq.verified_email],
      ['Has team info', dq.with_team],
      ['Has jobs found', dq.with_jobs],
      ['Has a website', dq.with_website],
    ];
    return rows.map(([label, n]) => `
      <div class="admin-quality-row">
        <div class="admin-quality-label">${escapeHtml(label)}</div>
        ${window.AdminCharts.meter(pct(n), AdminCharts.COLORS.blue)}
        <div class="admin-quality-pct">${pct(n)}%</div>
      </div>`).join('');
  }

  async function loadOverview() {
    const panel = document.getElementById('panel-overview');
    panel.innerHTML = `<div class="admin-loading">Loading…</div>`;
    let stats, analytics;
    try {
      const [statsResp, analyticsResp] = await Promise.all([
        fetch('/api/admin/stats', { headers: authHeaders() }),
        fetch(`/api/admin/analytics?days=${overviewDays}`, { headers: authHeaders() }),
      ]);
      if (statsResp.status === 401 || analyticsResp.status === 401) { clearToken(); showLogin(); return; }
      if (!statsResp.ok) throw new Error(`/api/admin/stats -> ${statsResp.status}`);
      if (!analyticsResp.ok) throw new Error(`/api/admin/analytics -> ${analyticsResp.status}`);
      [stats, analytics] = await Promise.all([statsResp.json(), analyticsResp.json()]);
    } catch (err) {
      panel.innerHTML = `<div class="admin-loading">Could not load the dashboard (${escapeHtml(err.message)}). <button type="button" class="admin-btn admin-btn-outline" onclick="AdminApp.switchTab('overview')">Retry</button></div>`;
      return;
    }
    try {
      renderOverview(stats, analytics);
    } catch (err) {
      panel.innerHTML = `<div class="admin-loading">Dashboard render error: ${escapeHtml(err.message)}</div>`;
      console.error(err);
    }
  }

  function renderOverview(stats, analytics) {
    const panel = document.getElementById('panel-overview');
    const { scans, pipeline, job_quality, ai_fit, user_count, config } = stats;
    const pipelineTotal = (pipeline.none || 0) + (pipeline.interested || 0) + (pipeline.applied || 0) + (pipeline.skipped || 0);
    const savedOrApplied = Math.max(1, (pipeline.interested || 0) + (pipeline.applied || 0));
    const applyRate = Math.round(((pipeline.applied || 0) / savedOrApplied) * 100);

    const configRow = (label, ok) => `
      <div class="admin-config-row">
        <span class="admin-config-dot ${ok ? 'on' : 'off'}"></span>
        <span>${escapeHtml(label)}</span>
        <span class="admin-config-state">${ok ? 'Connected' : 'Not set'}</span>
      </div>`;

    const recentScansRows = (scans.recent || []).map(s => `
      <tr>
        <td>${fmtDateTime(s.created_at)}</td>
        <td>${escapeHtml(s.user_email || '—')}</td>
        <td>${escapeHtml(s.provider || '—')}</td>
        <td>${fmtNum(s.result_count)}</td>
      </tr>`).join('');

    panel.innerHTML = `
      <div class="admin-kpi-row">
        <div class="admin-kpi-tile"><div class="admin-kpi-value">${fmtNum(user_count)}</div><div class="admin-kpi-label">Total users</div></div>
        <div class="admin-kpi-tile"><div class="admin-kpi-value">${fmtNum(analytics.data_quality.total)}</div><div class="admin-kpi-label">Companies discovered</div></div>
        <div class="admin-kpi-tile"><div class="admin-kpi-value">${fmtNum(scans.totals?.scan_count)}</div><div class="admin-kpi-label">Scans run</div></div>
        <div class="admin-kpi-tile"><div class="admin-kpi-value">${fmtNum(pipeline.applied)}</div><div class="admin-kpi-label">Applications submitted</div></div>
      </div>

      <div class="admin-grid">
        <div class="admin-card admin-card-wide">
          <div class="admin-card-head">
            <div>
              <div class="admin-card-title">Growth</div>
              <div class="admin-card-sub">Signups, scans and applications per day</div>
            </div>
            <div class="admin-range-toggle" id="rangeToggle">
              ${[7, 30, 90].map(d => `<button type="button" class="admin-range-btn ${d === overviewDays ? 'active' : ''}" data-days="${d}">${d}d</button>`).join('')}
            </div>
          </div>
          <div id="growthChart"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Pipeline funnel (all users)</div>
          <div class="admin-card-sub">Saved → applied conversion: ${applyRate}%</div>
          <div id="funnelChart" style="margin-top:10px"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Industries discovered</div>
          <div id="industryChart" style="margin-top:6px"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Data completeness</div>
          <div class="admin-card-sub">Share of scanned companies with usable contact/job data</div>
          <div style="margin-top:8px">${dataQualityRows(analytics.data_quality)}</div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Job quality (scam detection)</div>
          <div class="admin-stat-row">
            <div class="admin-stat"><div class="admin-stat-num">${fmtNum(job_quality.total)}</div><div class="admin-stat-label">Jobs scored</div></div>
            <div class="admin-stat"><div class="admin-stat-num">${fmtPct(job_quality.avg_score)}</div><div class="admin-stat-label">Avg quality</div></div>
            <div class="admin-stat"><div class="admin-stat-num">${fmtNum(job_quality.suspicious_count)}</div><div class="admin-stat-label">Flagged suspicious</div></div>
          </div>
          <div id="qualityBuckets"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">AI fit checks</div>
          <div class="admin-stat-row">
            <div class="admin-stat"><div class="admin-stat-num">${fmtNum(ai_fit.total)}</div><div class="admin-stat-label">Checks run</div></div>
            <div class="admin-stat"><div class="admin-stat-num">${ai_fit.avg_score != null ? Math.round(ai_fit.avg_score) : '—'}</div><div class="admin-stat-label">Avg score /100</div></div>
          </div>
          <div id="aiFitBuckets"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Top companies by interest</div>
          <div id="topCompaniesChart" style="margin-top:6px"></div>
        </div>

        <div class="admin-card">
          <div class="admin-card-title">Job sources</div>
          <div id="jobSourcesChart" style="margin-top:6px"></div>
        </div>

        <div class="admin-card admin-card-wide">
          <div class="admin-card-title">Recent scans</div>
          ${recentScansRows ? `
            <table class="admin-table">
              <thead><tr><th>When</th><th>User</th><th>Provider</th><th>Found</th></tr></thead>
              <tbody>${recentScansRows}</tbody>
            </table>` : '<div class="admin-empty-hint">No scans yet.</div>'}
        </div>

        <div class="admin-card admin-card-wide">
          <div class="admin-card-title">Connections</div>
          ${configRow('Google Places API', config.has_google_key)}
          ${configRow('Serper (LinkedIn/web search)', config.has_serper_key)}
          ${configRow('OpenAI (AI fit scoring)', config.has_openai_key)}
          ${configRow('SMTP (direct email send)', config.has_smtp)}
          <div class="admin-config-row"><span class="admin-config-dot on"></span><span>Places provider</span><span class="admin-config-state">${escapeHtml(config.places_provider)}</span></div>
          ${config.has_serper_key ? `
          <div class="admin-config-row">
            <span class="admin-config-dot ${config.serper_state === 'ok' ? 'on' : 'warn'}"></span>
            <span>Serper usage today</span>
            <span class="admin-config-state">${fmtNum(config.serper_usage_today)} / ${fmtNum(config.serper_daily_budget)}${config.serper_state !== 'ok' ? ` — ${escapeHtml(config.serper_message)}` : ''}</span>
          </div>` : ''}
        </div>
      </div>`;

    AdminCharts.lineMulti(document.getElementById('growthChart'), {
      labels: analytics.signups_series.map(r => r.day),
      series: [
        { label: 'Signups', color: AdminCharts.COLORS.blue, points: analytics.signups_series.map(r => r.n) },
        { label: 'Scans', color: AdminCharts.COLORS.aqua, points: analytics.scans_series.map(r => r.n) },
        { label: 'Applications', color: AdminCharts.COLORS.green, points: analytics.applied_series.map(r => r.n) },
      ],
    });

    AdminCharts.barH(document.getElementById('funnelChart'), {
      items: [
        { label: 'Untouched', value: pipeline.none || 0, color: '#4a4a5e' },
        { label: 'Saved', value: pipeline.interested || 0, color: AdminCharts.COLORS.blue },
        { label: 'Applied', value: pipeline.applied || 0, color: AdminCharts.STATUS.good },
        { label: 'Skipped', value: pipeline.skipped || 0, color: '#4a4a5e' },
      ],
    });

    AdminCharts.barH(document.getElementById('industryChart'), {
      items: analytics.industries.map(i => ({ label: industryLabel(i.cat), value: i.n })),
    });

    AdminCharts.buckets(document.getElementById('qualityBuckets'), {
      items: [
        { label: 'Critical', value: analytics.quality_buckets.critical, color: AdminCharts.STATUS.critical },
        { label: 'Serious', value: analytics.quality_buckets.serious, color: AdminCharts.STATUS.serious },
        { label: 'Fair', value: analytics.quality_buckets.warning, color: AdminCharts.STATUS.warning },
        { label: 'Good', value: analytics.quality_buckets.good, color: AdminCharts.STATUS.good },
      ],
    });

    AdminCharts.buckets(document.getElementById('aiFitBuckets'), {
      items: [
        { label: '0-25', value: analytics.ai_fit_buckets.critical, color: AdminCharts.STATUS.critical },
        { label: '25-50', value: analytics.ai_fit_buckets.serious, color: AdminCharts.STATUS.serious },
        { label: '50-75', value: analytics.ai_fit_buckets.warning, color: AdminCharts.STATUS.warning },
        { label: '75-100', value: analytics.ai_fit_buckets.good, color: AdminCharts.STATUS.good },
      ],
    });

    AdminCharts.barH(document.getElementById('topCompaniesChart'), {
      items: analytics.top_companies.map(c => ({ label: c.name, value: c.n })),
      color: AdminCharts.COLORS.violet,
    });

    AdminCharts.barH(document.getElementById('jobSourcesChart'), {
      items: analytics.job_sources.map(s => ({ label: s.source, value: s.n })),
      color: AdminCharts.COLORS.orange,
    });

    document.querySelectorAll('#rangeToggle .admin-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overviewDays = Number(btn.dataset.days);
        loadOverview();
      });
    });
  }

  // ---- users ------------------------------------------------------------

  async function loadUsers() {
    const panel = document.getElementById('panel-users');
    panel.innerHTML = `<div class="admin-loading">Loading…</div>`;
    try {
      const data = await fetch('/api/admin/users', { headers: authHeaders() }).then(r => r.json());
      usersCache = data.users || [];
    } catch {
      panel.innerHTML = `<div class="admin-loading">Could not reach the server.</div>`;
      return;
    }
    panel.innerHTML = renderUsersTable();
  }

  function renderUsersTable() {
    if (!usersCache.length) {
      return `<div class="admin-card"><div class="admin-empty-hint">No users have signed up yet.</div></div>`;
    }
    const rows = usersCache.map(u => `
      <tr class="${u.suspended ? 'admin-user-suspended' : ''}">
        <td>
          <a href="#" class="admin-user-link" onclick="AdminApp.openUserDrawer('${escapeHtml(u.id)}');return false;">
            ${escapeHtml(u.profile?.name || '(no name)')}
          </a>
          ${u.suspended ? '<span class="admin-setting-badge admin-badge-suspended">suspended</span>' : ''}
        </td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.onboardingComplete ? 'Complete' : 'Incomplete'}</td>
        <td>${fmtNum(u.savedCount)}</td>
        <td>${fmtNum(u.appliedCount)}</td>
        <td>${fmtNum(u.skippedCount)}</td>
        <td>${fmtDate(u.createdAt)}</td>
      </tr>`).join('');
    return `
      <div class="admin-card admin-card-wide admin-card-nopad">
        <table class="admin-table admin-users-table">
          <thead><tr><th>Name</th><th>Email</th><th>Onboarding</th><th>Saved</th><th>Applied</th><th>Skipped</th><th>Joined</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  async function openUserDrawer(id) {
    document.getElementById('drawerBackdrop').classList.add('open');
    document.getElementById('userDrawer').classList.add('open');
    document.getElementById('drawerTitle').textContent = 'Loading…';
    document.getElementById('drawerBody').innerHTML = `<div class="admin-loading">Loading…</div>`;
    try {
      const data = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { headers: authHeaders() }).then(r => r.json());
      renderUserDrawer(data.user, data.learning);
    } catch {
      document.getElementById('drawerBody').innerHTML = `<div class="admin-loading">Could not load this user.</div>`;
    }
  }

  function closeUserDrawer(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('drawerBackdrop').classList.remove('open');
    document.getElementById('userDrawer').classList.remove('open');
  }

  function featurePill(f, kind) {
    return `
      <div class="admin-feature-pill ${kind}">
        <span class="admin-feature-name">${escapeHtml(f.feature)}</span>
        <span class="admin-feature-meta">${f.weight > 0 ? '+' : ''}${f.weight.toFixed(2)} · ${f.sample_count}×</span>
      </div>`;
  }

  function renderUserDrawer(user, learning) {
    document.getElementById('drawerTitle').textContent = user.profile?.name || user.email;
    const p = user.profile || {};
    document.getElementById('drawerBody').innerHTML = `
      <div class="admin-drawer-section">
        <div class="admin-drawer-row"><span>Email</span><span>${escapeHtml(user.email)}</span></div>
        <div class="admin-drawer-row"><span>City</span><span>${escapeHtml(p.city || '—')}</span></div>
        <div class="admin-drawer-row"><span>Onboarding</span><span>${user.onboardingComplete ? 'Complete' : 'Incomplete'}</span></div>
        <div class="admin-drawer-row"><span>Joined</span><span>${fmtDateTime(user.createdAt)}</span></div>
        <div class="admin-drawer-row"><span>Industries</span><span>${(p.jobSectors || []).join(', ') || '—'}</span></div>
        <div class="admin-drawer-row"><span>Skills</span><span>${(p.skills || []).join(', ') || '—'}</span></div>
        <div class="admin-drawer-row"><span>Status</span><span>${user.suspended ? 'Suspended' : 'Active'}</span></div>
      </div>

      <div class="admin-drawer-section">
        <div class="admin-card-title">What their learning model has picked up</div>
        <div class="admin-stat-row">
          <div class="admin-stat"><div class="admin-stat-num">${fmtNum(learning.confident_features)}</div><div class="admin-stat-label">Confident signals</div></div>
          <div class="admin-stat"><div class="admin-stat-num">${fmtNum(learning.total_features_tracked)}</div><div class="admin-stat-label">Total tracked</div></div>
        </div>
        ${learning.top_liked?.length ? learning.top_liked.map(f => featurePill(f, 'liked')).join('') : '<div class="admin-empty-hint">No confident "likes" yet.</div>'}
        ${learning.top_avoided?.length ? learning.top_avoided.map(f => featurePill(f, 'avoided')).join('') : ''}
      </div>

      <div class="admin-drawer-actions">
        <button type="button" class="admin-btn admin-btn-outline" onclick="AdminApp.toggleSuspend('${escapeHtml(user.id)}', ${!user.suspended})">
          ${user.suspended ? 'Unsuspend account' : 'Suspend account'}
        </button>
        <button type="button" class="admin-btn admin-btn-danger" onclick="AdminApp.deleteUserConfirm('${escapeHtml(user.id)}')">
          Delete account
        </button>
      </div>`;
  }

  async function toggleSuspend(id, suspended) {
    try {
      await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ suspended }),
      });
      await openUserDrawer(id);
      await loadUsers();
    } catch {
      alert('Could not update this user — try again.');
    }
  }

  async function deleteUserConfirm(id) {
    const user = usersCache.find(u => u.id === id);
    if (!window.confirm(`Permanently delete ${user?.email || 'this account'} and all their saved/applied data? This cannot be undone.`)) return;
    try {
      await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
      closeUserDrawer();
      await loadUsers();
    } catch {
      alert('Could not delete this user — try again.');
    }
  }

  // ---- settings ---------------------------------------------------------

  async function loadSettings() {
    const panel = document.getElementById('panel-settings');
    panel.innerHTML = `<div class="admin-loading">Loading…</div>`;
    let settings;
    try {
      const data = await fetch('/api/admin/settings', { headers: authHeaders() }).then(r => r.json());
      settings = data.settings || [];
    } catch {
      panel.innerHTML = `<div class="admin-loading">Could not reach the server.</div>`;
      return;
    }
    panel.innerHTML = `
      <div class="admin-card admin-card-wide">
        <div class="admin-card-title">Scan tuning</div>
        <p class="admin-settings-hint">Changes apply immediately across all users — no restart needed.</p>
        <div class="admin-settings-list">${settingsRows(settings)}</div>
      </div>`;
  }

  function settingsRows(settings) {
    return settings.map(s => `
      <div class="admin-setting-row">
        <div class="admin-setting-info">
          <div class="admin-setting-label">${escapeHtml(s.label)}${s.is_override ? ' <span class="admin-setting-badge">custom</span>' : ''}</div>
          <div class="admin-setting-hint">${escapeHtml(s.hint)}</div>
        </div>
        <input type="number" class="admin-input admin-setting-input" min="${s.min}" max="${s.max}" value="${s.value}"
          onchange="AdminApp.updateSetting('${escapeHtml(s.key)}', this.value)" />
      </div>`).join('');
  }

  async function updateSetting(key, value) {
    try {
      const resp = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ key, value }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Update failed');
      const list = document.querySelector('#panel-settings .admin-settings-list');
      if (list) list.innerHTML = settingsRows(data.settings || []);
    } catch (err) {
      alert(err.message || 'Could not update setting');
      loadSettings();
    }
  }

  window.AdminApp = {
    login, logout, switchTab,
    openUserDrawer, closeUserDrawer, toggleSuspend, deleteUserConfirm,
    updateSetting,
  };

  boot();
})();
