(function () {
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

  // The admin session lives in an httpOnly cookie (areahunt_admin_session),
  // sent automatically on every same-origin request — nothing to attach here.
  function authHeaders() {
    return { 'Content-Type': 'application/json' };
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
      document.getElementById('adminPassword').value = '';
      showShell();
    } catch (err) {
      showLogin(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  async function logout() {
    try { await fetch('/api/admin-auth/logout', { method: 'POST', headers: authHeaders() }); } catch {}
    showLogin();
  }

  async function boot() {
    document.getElementById('adminPassword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });
    // No local guard — the httpOnly cookie is the source of truth for
    // whether we're signed in, so this always asks the server first.
    const resp = await fetch('/api/admin/stats', { headers: authHeaders() });
    if (resp.status === 401) { showLogin(); return; }
    showShell();
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.admin-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.admin-tab-panel').forEach(el => el.classList.add('hidden'));
    document.getElementById(`panel-${tab}`).classList.remove('hidden');
    if (tab === 'overview') loadOverview();
    if (tab === 'ai') loadAi();
    if (tab === 'users') loadUsers();
    if (tab === 'settings') loadSettings();
    if (tab === 'audit') loadAuditLog();
  }

  // ---- AI: semantic job matching -------------------------------------

  async function loadAi() {
    const panel = document.getElementById('panel-ai');
    panel.innerHTML = '<div class="admin-loading">Loading AI matcher…</div>';
    let status;
    try {
      status = await fetch('/api/admin/ai/status', { headers: authHeaders() }).then(r => r.json());
    } catch (err) {
      panel.innerHTML = `<div class="admin-loading">Could not load the AI matcher (${escapeHtml(err.message)}).</div>`;
      return;
    }
    const neural = status.neural_available;
    panel.innerHTML = `
      <div class="admin-card admin-card-wide">
        <div class="admin-card-title">Semantic job matching</div>
        <p class="admin-empty-hint" style="margin:2px 0 12px">
          Paste a candidate's skills or a whole profile — the matcher ranks every job in the
          corpus by <strong>meaning overlap</strong>, not keyword equality.
        </p>
        <div class="admin-config-row">
          <span class="admin-config-dot on"></span><span>Engine</span>
          <span class="admin-config-state">${escapeHtml(status.method)}</span>
        </div>
        <div class="admin-config-row">
          <span class="admin-config-dot on"></span><span>Jobs indexed</span>
          <span class="admin-config-state">${fmtNum(status.corpus_size)}</span>
        </div>
        <div class="admin-config-row">
          <span class="admin-config-dot ${neural ? 'on' : 'warn'}"></span><span>Neural embeddings</span>
          <span class="admin-config-state">${neural ? 'on' : 'off — set EMBEDDINGS_PROVIDER + key to upgrade (v1 runs locally, no key)'}</span>
        </div>
        <div class="admin-config-row">
          <span class="admin-config-dot ${status.llm_reasoning ? 'on' : 'warn'}"></span><span>LLM reasoning</span>
          <span class="admin-config-state">${status.llm_reasoning ? `on · ${escapeHtml(status.llm_model || '')}` : 'off — set ANTHROPIC_API_KEY to switch on real AI reasoning'}</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <input type="text" id="aiQuery" class="admin-input" style="flex:1"
                 placeholder="e.g. senior react developer, node, aws, australian work rights"
                 onkeydown="if(event.key==='Enter')AdminApp.runAiMatch()" />
          <button type="button" class="admin-btn admin-btn-outline" onclick="AdminApp.runAiMatch()">Match</button>
          <button type="button" class="admin-btn admin-btn-primary" onclick="AdminApp.runAiAnalyze()"
                  title="${status.llm_reasoning ? 'Real LLM reasoning over the matches' : 'Needs ANTHROPIC_API_KEY on the server'}">Analyze with AI ✨</button>
        </div>
        <div id="aiResults" style="margin-top:14px"></div>
      </div>`;
  }

  async function runAiAnalyze() {
    const q = (document.getElementById('aiQuery')?.value || '').trim();
    const box = document.getElementById('aiResults');
    if (!q) { box.innerHTML = '<div class="admin-empty-hint">Describe a candidate first (skills, experience, work rights).</div>'; return; }
    box.innerHTML = '<div class="admin-loading">Reasoning over the matches with the LLM…</div>';
    let data;
    try {
      data = await fetch(`/api/admin/ai/analyze?q=${encodeURIComponent(q)}`, { headers: authHeaders() }).then(r => r.json());
    } catch (err) {
      box.innerHTML = `<div class="admin-empty-hint">Analyze failed: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (data.available === false) {
      box.innerHTML = `<div class="admin-empty-hint" style="line-height:1.5">
        <strong>Real AI reasoning is built but switched off.</strong><br>
        Set <code>ANTHROPIC_API_KEY</code> on the server (Render → Environment) and this becomes real Claude
        reading each candidate and job. The same key also switches on AI fit-scores and cover letters.
      </div>`;
      return;
    }
    if (data.error) { box.innerHTML = `<div class="admin-empty-hint">LLM call failed: ${escapeHtml(data.error)}</div>`; return; }
    const a = data.analysis;
    if (!a) { box.innerHTML = '<div class="admin-empty-hint">No jobs matched to reason over yet — the corpus may be small.</div>'; return; }
    const matches = (a.matches || []).map(m => {
      const title = m.url ? `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${escapeHtml(m.title)}</a>` : escapeHtml(m.title);
      const co = m.company_name ? ` · ${escapeHtml(m.company_name)}` : '';
      const barrier = m.barrier && !/^none/i.test(m.barrier) ? `<div class="admin-empty-hint" style="color:#e0a458">⚠ ${escapeHtml(m.barrier)}</div>` : '';
      return `<div class="admin-quality-row" style="align-items:flex-start">
        <div class="admin-quality-label" style="flex:1">
          <div>${title}<span class="admin-empty-hint">${co}</span></div>
          <div class="admin-empty-hint" style="color:#c9d1d9">${escapeHtml(m.why || '')}</div>
          ${barrier}
        </div>
        ${window.AdminCharts.meter(m.fit, AdminCharts.COLORS.green)}
        <div class="admin-quality-pct">${m.fit}%</div>
      </div>`;
    }).join('');
    box.innerHTML = `
      <div class="admin-card" style="background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.2);margin-bottom:12px">
        <div class="admin-empty-hint" style="text-transform:uppercase;letter-spacing:.05em;font-size:11px">AI read · ${escapeHtml(data.model || '')}</div>
        <div style="margin:6px 0;line-height:1.5">${escapeHtml(a.summary || '')}</div>
        ${a.advice ? `<div style="margin-top:8px"><strong>Next step:</strong> ${escapeHtml(a.advice)}</div>` : ''}
      </div>
      ${matches}`;
  }

  async function runAiMatch() {
    const q = (document.getElementById('aiQuery')?.value || '').trim();
    const box = document.getElementById('aiResults');
    if (!q) { box.innerHTML = '<div class="admin-empty-hint">Type some skills or a profile first.</div>'; return; }
    box.innerHTML = '<div class="admin-loading">Ranking…</div>';
    let data;
    try {
      data = await fetch(`/api/admin/ai/match?q=${encodeURIComponent(q)}&limit=15`, { headers: authHeaders() }).then(r => r.json());
    } catch (err) {
      box.innerHTML = `<div class="admin-empty-hint">Match failed: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const results = data.results || [];
    if (!results.length) {
      box.innerHTML = '<div class="admin-empty-hint">No matches — the corpus may be small, or none of these terms appear in any posting yet.</div>';
      return;
    }
    const rows = results.map(r => {
      const pct = Math.round(r.score * 100);
      const co = r.company_name ? ` · ${escapeHtml(r.company_name)}` : '';
      const loc = r.location ? ` · ${escapeHtml(r.location)}` : '';
      const title = r.url
        ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>`
        : escapeHtml(r.title);
      return `
        <div class="admin-quality-row">
          <div class="admin-quality-label">${title}<span class="admin-empty-hint">${co}${loc} · ${escapeHtml(r.source || '')}</span></div>
          ${window.AdminCharts.meter(pct, AdminCharts.COLORS.blue)}
          <div class="admin-quality-pct">${pct}%</div>
        </div>`;
    }).join('');
    box.innerHTML = `<div class="admin-empty-hint" style="margin-bottom:8px">Top ${results.length} of ${fmtNum(data.corpus_size)} jobs · ${escapeHtml(data.method)}</div>${rows}`;
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
      if (statsResp.status === 401 || analyticsResp.status === 401) { showLogin(); return; }
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
    const inPipelineCount = (pipeline.applied || 0) + (pipeline.interviewing || 0) + (pipeline.offer || 0) + (pipeline.rejected || 0);
    const pipelineTotal = (pipeline.none || 0) + (pipeline.interested || 0) + inPipelineCount + (pipeline.skipped || 0);
    const savedOrApplied = Math.max(1, (pipeline.interested || 0) + inPipelineCount);
    const applyRate = Math.round((inPipelineCount / savedOrApplied) * 100);

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
          ${configRow('Claude (AI features)', config.has_ai_key)}
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
        { label: 'Interviewing', value: pipeline.interviewing || 0, color: AdminCharts.COLORS.yellow },
        { label: 'Offer', value: pipeline.offer || 0, color: AdminCharts.COLORS.violet },
        { label: 'Rejected', value: pipeline.rejected || 0, color: AdminCharts.COLORS.red },
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

  const AUDIT_ACTION_LABELS = {
    setting_updated: 'Setting changed',
    user_suspended: 'User suspended',
    user_unsuspended: 'User unsuspended',
    user_deleted: 'User deleted',
  };

  async function loadAuditLog() {
    const panel = document.getElementById('panel-audit');
    panel.innerHTML = `<div class="admin-loading">Loading…</div>`;
    let actions;
    try {
      const data = await fetch('/api/admin/audit-log', { headers: authHeaders() }).then(r => r.json());
      actions = data.actions || [];
    } catch {
      panel.innerHTML = `<div class="admin-loading">Could not reach the server.</div>`;
      return;
    }
    if (!actions.length) {
      panel.innerHTML = `<div class="admin-card admin-card-wide"><div class="admin-card-title">Audit log</div><p class="admin-settings-hint">No admin actions recorded yet.</p></div>`;
      return;
    }
    panel.innerHTML = `
      <div class="admin-card admin-card-wide">
        <div class="admin-card-title">Audit log</div>
        <p class="admin-settings-hint">Every admin action (settings changes, suspend/delete) — there's one shared admin password, not per-admin accounts, so this shows what happened and the requesting IP, not which specific person.</p>
        <table class="admin-table">
          <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th><th>From IP</th></tr></thead>
          <tbody>${actions.map(a => `
            <tr>
              <td>${escapeHtml(fmtDateTime(a.created_at))}</td>
              <td>${escapeHtml(AUDIT_ACTION_LABELS[a.action] || a.action)}</td>
              <td>${escapeHtml(a.target || '—')}</td>
              <td>${escapeHtml(a.detail || '—')}</td>
              <td>${escapeHtml(a.actor_ip || '—')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  window.AdminApp = {
    login, logout, switchTab, runAiMatch, runAiAnalyze,
    openUserDrawer, closeUserDrawer, toggleSuspend, deleteUserConfirm,
    updateSetting,
  };

  boot();
})();
