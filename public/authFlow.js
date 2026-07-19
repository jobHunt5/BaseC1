// Login gate + multi-step onboarding. Real email/password auth (server-side
// scrypt hashing — see server/services/passwordService.js).

const AuthGate = (() => {
  const SESSION_KEY = 'areahunt.session.v1';
  const LOCAL_PROFILE_KEY = 'areahunt.profile.v2';

  const SECTOR_OPTIONS = typeof AreaHuntIndustries !== 'undefined'
    ? AreaHuntIndustries.onboardingOptions()
    : [
      { id: 'all', label: 'All industries', icon: 'sparkles', desc: 'Open to any type of work' },
      { id: 'design', label: 'Designer', icon: 'design', desc: 'UI/UX, branding, graphic' },
      { id: 'dev', label: 'Developer', icon: 'dev', desc: 'Software, web, mobile' },
    ];

  const EMPLOYMENT_OPTIONS = [
    { id: 'full-time', label: 'Full-time' },
    { id: 'part-time', label: 'Part-time' },
    { id: 'contract', label: 'Contract' },
    { id: 'freelance', label: 'Freelance / client work' },
    { id: 'internship', label: 'Internship' },
  ];

  const WORK_MODE_OPTIONS = [
    { id: 'remote', label: 'Remote' },
    { id: 'hybrid', label: 'Hybrid' },
    { id: 'on-site', label: 'On-site' },
  ];

  const TIME_COMMITMENT_OPTIONS = [
    { id: 'browsing', label: 'Just browsing', desc: 'Casually looking, no rush' },
    { id: 'few-hours', label: 'A few hours a week', desc: 'Fitting it around other things' },
    { id: 'active', label: 'Actively searching', desc: '10–20 hrs/week' },
    { id: 'all-in', label: 'All in', desc: '20+ hrs/week, urgent' },
  ];

  // Core to matching in the Australian market — a huge share of job
  // postings explicitly require citizenship/PR or say nothing at all about
  // sponsorship, and a huge share of job seekers here are on a visa. This
  // is what lets the app flag "you likely can't apply to this one" instead
  // of surfacing roles indiscriminately.
  const WORK_RIGHTS_OPTIONS = [
    { id: 'citizen', label: 'Australian citizen', desc: 'Unrestricted work rights' },
    { id: 'pr', label: 'Permanent resident', desc: 'Unrestricted work rights' },
    { id: 'visa-full', label: 'Visa — full work rights', desc: 'e.g. partner, some skilled visas' },
    { id: 'visa-limited', label: 'Visa — limited hours', desc: 'e.g. student visa' },
    { id: 'visa-sponsorship', label: 'Need visa sponsorship', desc: 'Employer must sponsor' },
    { id: 'working-holiday', label: 'Working holiday visa', desc: 'Usually 6 months per employer' },
  ];

  // Industries where a portfolio link is a normal part of applying. Used to
  // pick a sensible default for the "I usually need a portfolio" checkbox in
  // Step 5 instead of defaulting it to checked for every candidate — a chef,
  // driver, or cleaner shouldn't be blocked from finishing onboarding by a
  // portfolio requirement that never applies to them.
  const PORTFOLIO_RELEVANT_SECTORS = ['design', 'dev', 'ai', 'marketing', 'creative'];

  let session = null;
  let step = 0;
  let draft = defaultProfile();
  let onReady = null;

  function defaultProfile() {
    return {
      name: '',
      email: '',
      city: '',
      phone: '',
      jobSectors: [],
      employmentTypes: [],
      workModes: [],
      timeCommitment: '',
      workRights: '',
      education: [],
      experienceYears: '',
      currentRole: '',
      experienceSummary: '',
      certifications: [],
      skills: [],
      // Resume-only fields — collected in the Profile modal, never in the
      // onboarding wizard, so the mandatory sign-up flow stays short. A
      // proper CV needs more structure than the cold-email `pitch`: a
      // distinct professional summary, a real work timeline, projects,
      // named links, and languages.
      summary: '',
      workHistory: [],
      projects: [],
      links: { github: '', linkedin: '', website: '' },
      languages: [],
      portfolioUrl: '',
      // null = "not yet decided" — Step 5 fills in a sensible default based
      // on the industries picked in Step 2 the first time it's reached, but
      // leaves it alone after that so it never overrides the candidate's own
      // choice. It used to hard-default to true for everyone, which meant a
      // chef or driver would hit a blocking validation error demanding a
      // portfolio URL to finish signing up.
      portfolioRequired: null,
      portfolioNotes: '',
      pitch: '',
      signature: '',
      emailAccount: null,
      onboardingStep: 1,
    };
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch { session = null; }
  }

  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  }

  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  function syncLocalProfile(profile) {
    try { localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile)); } catch {}
    const legacy = {
      name: profile.name || '',
      city: profile.city || '',
      skills: profile.skills || [],
      portfolio: profile.portfolioUrl || profile.portfolio || '',
      pitch: profile.pitch || '',
      signature: profile.signature || profile.name || '',
      jobSectors: profile.jobSectors || [],
    };
    try { localStorage.setItem('areahunt.profile.v1', JSON.stringify(legacy)); } catch {}
  }

  function profileNeedsOnboarding(p) {
    if (!p?.name?.trim()) return true;
    if (!p.jobSectors?.length) return true;
    if (!p.employmentTypes?.length) return true;
    if (!p.workModes?.length) return true;
    const hasEdu = (p.education || []).some(e => e.degree || e.institution || e.field);
    if (!hasEdu) return true;
    if (!p.skills?.length && !p.currentRole?.trim()) return true;
    return false;
  }

  function inferResumeStep(p) {
    if (!p?.name) return 1;
    if (!p.jobSectors?.length) return 2;
    const hasEdu = (p.education || []).some(e => e.degree || e.institution || e.field);
    if (!hasEdu) return 3;
    if (!p.skills?.length && !p.experienceYears && !p.currentRole) return 4;
    return Math.min(Math.max(p.onboardingStep || 5, 1), 5);
  }

  async function persistDraft(complete = false) {
    if (!session?.token) {
      syncLocalProfile(draft);
      return draft;
    }
    draft.email = session.email;
    draft.onboardingStep = step;
    if (!draft.signature && draft.name) draft.signature = draft.name;
    try {
      const saved = await apiSaveProfile({ ...draft }, complete);
      session.profile = saved?.profile || { ...draft };
      if (complete) session.onboardingComplete = true;
      saveSession();
      syncLocalProfile(session.profile);
      return session.profile;
    } catch (err) {
      syncLocalProfile(draft);
      throw err;
    }
  }

  async function saveProfileToServer(partialProfile, onboardingComplete) {
    if (!session?.token) {
      syncLocalProfile({ ...draft, ...partialProfile });
      return { ...draft, ...partialProfile };
    }
    const merged = {
      ...defaultProfile(),
      ...session.profile,
      ...partialProfile,
      email: session.email,
    };
    // Quick profile edits must never flip onboarding to "done".
    const complete = onboardingComplete === true
      ? true
      : onboardingComplete === false
        ? false
        : !!session.onboardingComplete;
    const saved = await apiSaveProfile(merged, complete);
    session.profile = saved?.profile || merged;
    session.onboardingComplete = saved?.onboardingComplete ?? complete;
    saveSession();
    syncLocalProfile(session.profile);
    return session.profile;
  }

  function authHeaders() {
    return session?.token
      ? { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  async function apiLogin(email, password) {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Login failed');
    return data;
  }

  async function apiSaveProfile(profile, onboardingComplete) {
    if (!session?.token) return null;
    const resp = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ profile, onboardingComplete }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Could not save profile');
    return data;
  }

  async function apiDeleteAccount(password) {
    if (!session?.token) return;
    const resp = await fetch('/api/auth/me', {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Could not delete account');
    return data;
  }

  async function deleteAccount(password) {
    await apiDeleteAccount(password);
    clearSession();
    setUserChip();
    showLogin();
  }

  async function apiMe() {
    if (!session?.token) return null;
    const resp = await fetch('/api/auth/me', { headers: authHeaders() });
    if (resp.ok) return resp.json();
    if (resp.status === 401) {
      // Stale token from old format — force fresh login
      clearSession();
    }
    return null;
  }

  function showLogin() {
    showGate();
    renderLogin();
  }

  function showGate() {
    document.getElementById('authGate').classList.add('show');
    document.body.classList.add('auth-locked');
  }

  function hideGate() {
    document.getElementById('authGate').classList.remove('show');
    document.body.classList.remove('auth-locked');
  }

  // Inline, non-blocking validation errors — replaces native alert() popups,
  // which interrupt the flow and look out of place next to the rest of the
  // app's dark UI (the main app already avoids alert() in favour of toasts).
  function showObError(msg) {
    const el = document.getElementById('obError');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'flex';
  }

  function clearObError() {
    const el = document.getElementById('obError');
    if (!el) return;
    el.style.display = 'none';
    el.textContent = '';
  }

  function setUserChip() {
    const chip = document.getElementById('userChip');
    const signIn = document.getElementById('signInBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    if (!session) {
      if (chip) chip.style.display = 'none';
      if (signIn) signIn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      return;
    }
    if (signIn) signIn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
    if (!chip) return;
    const name = session.profile?.name || session.email?.split('@')[0] || 'User';
    chip.textContent = name;
    chip.title = session.email;
    chip.style.display = '';
  }

  const STEP_META = {
    1: { icon: 'person', label: 'About you' },
    2: { icon: 'briefcase', label: 'Work preferences' },
    3: { icon: 'book', label: 'Education' },
    4: { icon: 'star', label: 'Experience' },
    5: { icon: 'folder', label: 'Portfolio' },
  };

  function renderProgress() {
    const el = document.getElementById('obProgress');
    if (!el) return;
    // No stepper on the login screen itself — it only makes sense once
    // you're actually inside the 5-step wizard.
    if (step < 1) { el.innerHTML = ''; return; }
    const total = 5;
    const nodes = [];
    for (let i = 1; i <= total; i++) {
      const state = i < step ? 'done' : i === step ? 'active' : '';
      const doneIcon = typeof AreaHuntIndustries !== 'undefined' ? AreaHuntIndustries.iconSvg('check', 12) : '✓';
      nodes.push(`<div class="ob-step-node ${state}">${i < step ? doneIcon : i}</div>`);
      if (i < total) nodes.push(`<div class="ob-step-line ${i < step ? 'done' : ''}"></div>`);
    }
    el.innerHTML = `<div class="ob-stepper">${nodes.join('')}</div>`;
  }

  function renderLogin() {
    step = 0;
    renderProgress();
    clearObError();
    document.getElementById('authGateNav').innerHTML = '';
    document.getElementById('authGateBody').innerHTML = `
      <div class="auth-brand">
        <div class="auth-brand-mark"><svg width="22" height="22"><use href="#icon-logo"></use></svg></div>
        <div class="auth-logo">Area<span>Hunt</span></div>
        <p>Sign in to save your job hunt, preferences, and applications.</p>
      </div>
      <div class="auth-demo-note">New here? Just enter an email and a password (8+ characters) to create your account.</div>
      <label class="form-label">Email</label>
      <input class="form-input" id="loginEmail" type="email" placeholder="you@example.com" autocomplete="username" />
      <label class="form-label">Password</label>
      <input class="form-input" id="loginPassword" type="password" placeholder="••••••••" autocomplete="current-password" />
      <button class="btn btn-primary auth-submit" id="loginBtn">Sign in</button>
      <p class="auth-foot">By continuing you agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>. We'll ask for your name and details next.</p>`;

    document.getElementById('loginBtn').onclick = submitLogin;
    document.getElementById('loginPassword').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitLogin();
    });
  }

  async function submitLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginBtn');
    clearObError();
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const data = await apiLogin(email, password);
      session = {
        token: data.token,
        email: data.user.email,
        id: data.user.id,
        profile: { ...defaultProfile(), ...data.user.profile, email: data.user.email },
        onboardingComplete: data.user.onboardingComplete,
      };
      saveSession();
      draft = { ...defaultProfile(), ...session.profile };
      // Name is only ever collected in onboarding Step 1 now (never at login),
      // so a fresh sign-in with no profile yet always lands on step 1 — no
      // risk of `inferResumeStep` seeing a name and silently skipping the
      // rest of that step (city/phone were being lost that way before).
      step = session.onboardingComplete && !profileNeedsOnboarding(session.profile)
        ? 0
        : inferResumeStep(draft);
      if (session.onboardingComplete && !profileNeedsOnboarding(session.profile)) {
        finishBoot();
      } else {
        if (profileNeedsOnboarding(session.profile)) session.onboardingComplete = false;
        if (step < 1) step = 1;
        renderOnboardingStep();
      }
    } catch (err) {
      showObError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  function chipGroup(id, options, selected, multi = true) {
    return `<div class="chip-group" id="${id}">${options.map(o => {
      const on = selected.includes(o.id);
      const icon = o.icon && typeof AreaHuntIndustries !== 'undefined' ? AreaHuntIndustries.iconSvg(o.icon, 15) : '';
      const label = icon ? `<span class="chip-opt-label">${icon}<span>${o.label}</span></span>` : o.label;
      return `<button type="button" class="chip-opt ${on ? 'on' : ''}" data-id="${o.id}">${label}${o.desc ? `<span class="chip-desc">${o.desc}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }

  function bindSectorChips() {
    const el = document.getElementById('obSectors');
    if (!el) return;
    el.classList.add('sectors');
    el.querySelectorAll('.chip-opt').forEach(btn => {
      btn.onclick = () => {
        const idVal = btn.dataset.id;
        if (idVal === 'all') {
          draft.jobSectors = (draft.jobSectors || []).includes('all') ? [] : ['all'];
        } else {
          const set = new Set(draft.jobSectors || []);
          set.delete('all');
          if (set.has(idVal)) set.delete(idVal); else set.add(idVal);
          draft.jobSectors = Array.from(set);
        }
        el.querySelectorAll('.chip-opt').forEach(b => {
          b.classList.toggle('on', (draft.jobSectors || []).includes(b.dataset.id));
        });
      };
    });
  }

  // Single-select chip group backed by a plain string field (not an array
  // like bindChipGroup's multi=false path stores) — used for time commitment,
  // where "one value or none" is the natural shape.
  function bindSingleSelectChip(id, field) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('.chip-opt').forEach(btn => {
      btn.onclick = () => {
        draft[field] = draft[field] === btn.dataset.id ? '' : btn.dataset.id;
        el.querySelectorAll('.chip-opt').forEach(b => b.classList.toggle('on', b.dataset.id === draft[field]));
      };
    });
  }

  function bindChipGroup(id, field, multi = true) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('.chip-opt').forEach(btn => {
      btn.onclick = () => {
        const idVal = btn.dataset.id;
        if (multi) {
          const set = new Set(draft[field] || []);
          if (set.has(idVal)) set.delete(idVal); else set.add(idVal);
          draft[field] = Array.from(set);
        } else {
          draft[field] = [idVal];
        }
        bindChipGroup(id, field, multi);
        el.querySelectorAll('.chip-opt').forEach(b => {
          b.classList.toggle('on', (draft[field] || []).includes(b.dataset.id));
        });
      };
    });
  }

  function educationRow(edu, idx) {
    return `
      <div class="edu-row" data-idx="${idx}">
        <input class="form-input" placeholder="Degree (e.g. Bachelor of Design)" data-field="degree" value="${esc(edu.degree)}" />
        <input class="form-input" placeholder="Field of study" data-field="field" value="${esc(edu.field)}" />
        <div class="edu-row-split">
          <input class="form-input" placeholder="Institution" data-field="institution" value="${esc(edu.institution)}" />
          <input class="form-input" placeholder="Year" data-field="year" value="${esc(edu.year)}" />
        </div>
        ${idx > 0 ? `<button type="button" class="link-btn-small remove-edu">Remove</button>` : ''}
      </div>`;
  }

  function certRow(cert, idx) {
    return `
      <div class="cert-row" data-idx="${idx}">
        <input class="form-input" placeholder="Certification (e.g. Adobe Certified Expert)" data-field="name" value="${esc(cert.name)}" />
        <div class="edu-row-split">
          <input class="form-input" placeholder="Issuing body" data-field="issuer" value="${esc(cert.issuer)}" />
          <input class="form-input" placeholder="Year" data-field="year" value="${esc(cert.year)}" />
        </div>
        <input class="form-input" placeholder="Credential URL (optional)" data-field="url" value="${esc(cert.url)}" />
        ${idx > 0 ? `<button type="button" class="link-btn-small remove-cert">Remove</button>` : ''}
      </div>`;
  }

  function stepHeader() {
    const meta = STEP_META[step] || {};
    const icon = meta.icon && typeof AreaHuntIndustries !== 'undefined' ? AreaHuntIndustries.iconSvg(meta.icon, 18) : '';
    return `
      <div class="ob-step-header">
        <span class="ob-step-icon">${icon}</span>
        <span class="ob-step-eyebrow">Step ${step} of 5</span>
      </div>`;
  }

  function renderOnboardingStep() {
    renderProgress();
    clearObError();
    const body = document.getElementById('authGateBody');
    const nav = document.getElementById('authGateNav');
    // Restart the fade/slide-in animation on every step change (removing +
    // re-adding the class doesn't replay a CSS animation on its own, so we
    // force a reflow in between).
    body.classList.remove('ob-anim');
    void body.offsetWidth;
    body.classList.add('ob-anim');

    if (step === 1) {
      body.innerHTML = `
        ${stepHeader()}
        <h2 class="ob-title">About you</h2>
        <p class="ob-sub">We’ll use this to personalise job matches and outreach.</p>
        <label class="form-label">Full name</label>
        <input class="form-input" id="obName" value="${esc(draft.name)}" placeholder="Basil Sunny" />
        <label class="form-label">City / region</label>
        <input class="form-input" id="obCity" value="${esc(draft.city)}" placeholder="Melbourne, VIC" />
        <label class="form-label">Phone <span class="label-opt">(optional)</span></label>
        <input class="form-input" id="obPhone" value="${esc(draft.phone)}" placeholder="+61 4xx xxx xxx" />`;
    } else if (step === 2) {
      body.innerHTML = `
        ${stepHeader()}
        <h2 class="ob-title">What kind of work?</h2>
        <p class="ob-sub">Pick everything you’re open to — we’ll prioritise matching companies.</p>
        <label class="form-label">Industries you’re looking in</label>
        ${chipGroup('obSectors', SECTOR_OPTIONS, draft.jobSectors)}
        <p class="ob-hint">Pick all that apply — or choose “All industries”.</p>
        <label class="form-label">Employment type</label>
        ${chipGroup('obEmployment', EMPLOYMENT_OPTIONS, draft.employmentTypes)}
        <label class="form-label">Work mode</label>
        ${chipGroup('obWorkMode', WORK_MODE_OPTIONS, draft.workModes)}
        <label class="form-label">How much time can you invest in job hunting?</label>
        ${chipGroup('obTimeCommitment', TIME_COMMITMENT_OPTIONS, draft.timeCommitment ? [draft.timeCommitment] : [])}
        <label class="form-label">Your work rights in Australia</label>
        ${chipGroup('obWorkRights', WORK_RIGHTS_OPTIONS, draft.workRights ? [draft.workRights] : [])}
        <p class="ob-hint">We'll flag roles that need citizenship/PR or don't mention sponsorship, so you don't waste time on ones you're not eligible for.</p>`;
      bindSectorChips();
      bindChipGroup('obEmployment', 'employmentTypes');
      bindChipGroup('obWorkMode', 'workModes');
      bindSingleSelectChip('obTimeCommitment', 'timeCommitment');
      bindSingleSelectChip('obWorkRights', 'workRights');
    } else if (step === 3) {
      if (!draft.education.length) draft.education = [{ degree: '', field: '', institution: '', year: '' }];
      body.innerHTML = `
        ${stepHeader()}
        <h2 class="ob-title">Education</h2>
        <p class="ob-sub">Add your highest qualification first. More entries optional.</p>
        <div id="eduList">${draft.education.map(educationRow).join('')}</div>
        <button type="button" class="btn btn-outline ob-add-btn" id="addEdu">+ Add another</button>`;
      document.getElementById('addEdu').onclick = () => {
        collectStep();
        draft.education.push({ degree: '', field: '', institution: '', year: '' });
        renderOnboardingStep();
      };
      body.querySelectorAll('.remove-edu').forEach(btn => {
        btn.onclick = () => {
          collectStep();
          const row = btn.closest('.edu-row');
          draft.education.splice(parseInt(row.dataset.idx, 10), 1);
          renderOnboardingStep();
        };
      });
    } else if (step === 4) {
      body.innerHTML = `
        ${stepHeader()}
        <h2 class="ob-title">Experience & certifications</h2>
        <p class="ob-sub">Helps us filter roles at your level and pitch you correctly.</p>
        <label class="form-label">Years of experience</label>
        <select class="form-input" id="obExpYears">
          ${['', '0–1', '1–3', '3–5', '5–10', '10+'].map(y =>
            `<option value="${y}" ${draft.experienceYears === y ? 'selected' : ''}>${y || 'Select…'}</option>`).join('')}
        </select>
        <label class="form-label">Current / most recent role</label>
        <input class="form-input" id="obCurrentRole" value="${esc(draft.currentRole)}" placeholder="Freelance UI Designer" />
        <label class="form-label">Experience summary</label>
        <textarea class="form-input" id="obExpSummary" rows="3" placeholder="Brief career highlights…">${esc(draft.experienceSummary)}</textarea>
        <label class="form-label">Certifications <span class="label-opt">(optional)</span></label>
        <div id="certList">${(draft.certifications || []).map(certRow).join('')}</div>
        <button type="button" class="btn btn-outline ob-add-btn" id="addCert">+ Add certification</button>
        <label class="form-label">Key skills</label>
        <input class="form-input" id="obSkills" value="${esc((draft.skills || []).join(', '))}" placeholder="UI/UX, Figma, React, brand identity…" />`;
      document.getElementById('addCert').onclick = () => {
        collectStep();
        draft.certifications = draft.certifications || [];
        draft.certifications.push({ name: '', issuer: '', year: '', url: '' });
        renderOnboardingStep();
      };
      body.querySelectorAll('.remove-cert').forEach(btn => {
        btn.onclick = () => {
          collectStep();
          const row = btn.closest('.cert-row');
          draft.certifications.splice(parseInt(row.dataset.idx, 10), 1);
          renderOnboardingStep();
        };
      });
    } else if (step === 5) {
      if (draft.portfolioRequired === null || draft.portfolioRequired === undefined) {
        draft.portfolioRequired = (draft.jobSectors || []).some(id => PORTFOLIO_RELEVANT_SECTORS.includes(id));
      }
      body.innerHTML = `
        ${stepHeader()}
        <h2 class="ob-title">Portfolio & finish</h2>
        <p class="ob-sub">Many roles need a portfolio — tell us what you have.</p>
        <label class="form-label">Portfolio / work samples URL</label>
        <input class="form-input" id="obPortfolio" type="url" value="${esc(draft.portfolioUrl)}" placeholder="https://yourportfolio.com" />
        <label class="toggle-row">
          <input type="checkbox" id="obPortfolioRequired" ${draft.portfolioRequired ? 'checked' : ''} />
          <span class="toggle-box"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
          <span>I usually need a portfolio link when applying to jobs in my field</span>
        </label>
        <label class="form-label">Portfolio notes</label>
        <textarea class="form-input" id="obPortfolioNotes" rows="2" placeholder="Behance for design, GitHub for dev…">${esc(draft.portfolioNotes)}</textarea>
        <label class="form-label">Short pitch</label>
        <textarea class="form-input" id="obPitch" rows="3" placeholder="2 sentences about what you do…">${esc(draft.pitch)}</textarea>
        <label class="form-label">Email signature</label>
        <textarea class="form-input" id="obSig" rows="2" placeholder="Name&#10;email&#10;phone">${esc(draft.signature)}</textarea>`;
    }

    const backIcon = typeof AreaHuntIndustries !== 'undefined' ? AreaHuntIndustries.iconSvg('chevron-left', 13) : '';
    nav.innerHTML = `
      ${step > 1 ? `<button type="button" class="btn btn-outline" id="obBack">${backIcon}Back</button>` : '<span></span>'}
      <button type="button" class="btn btn-primary" id="obNext">${step === 5 ? 'Finish & start hunting' : 'Continue'}</button>`;
    document.getElementById('obBack')?.addEventListener('click', () => { collectStep(); step--; renderOnboardingStep(); });
    document.getElementById('obNext').addEventListener('click', submitStep);
  }

  function collectStep() {
    if (step === 1) {
      draft.name = document.getElementById('obName')?.value.trim() || draft.name;
      draft.city = document.getElementById('obCity')?.value.trim() || '';
      draft.phone = document.getElementById('obPhone')?.value.trim() || '';
    } else if (step === 3) {
      draft.education = [];
      document.querySelectorAll('.edu-row').forEach(row => {
        const entry = {};
        row.querySelectorAll('[data-field]').forEach(inp => {
          entry[inp.dataset.field] = inp.value.trim();
        });
        if (entry.degree || entry.field || entry.institution) draft.education.push(entry);
      });
      if (!draft.education.length) draft.education.push({ degree: '', field: '', institution: '', year: '' });
    } else if (step === 4) {
      draft.experienceYears = document.getElementById('obExpYears')?.value || '';
      draft.currentRole = document.getElementById('obCurrentRole')?.value.trim() || '';
      draft.experienceSummary = document.getElementById('obExpSummary')?.value.trim() || '';
      draft.certifications = [];
      document.querySelectorAll('.cert-row').forEach(row => {
        const entry = {};
        row.querySelectorAll('[data-field]').forEach(inp => {
          entry[inp.dataset.field] = inp.value.trim();
        });
        if (entry.name || entry.issuer) draft.certifications.push(entry);
      });
      draft.skills = (document.getElementById('obSkills')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    } else if (step === 5) {
      draft.portfolioUrl = document.getElementById('obPortfolio')?.value.trim() || '';
      draft.portfolioRequired = !!document.getElementById('obPortfolioRequired')?.checked;
      draft.portfolioNotes = document.getElementById('obPortfolioNotes')?.value.trim() || '';
      draft.pitch = document.getElementById('obPitch')?.value.trim() || '';
      draft.signature = document.getElementById('obSig')?.value.trim() || draft.name;
    }
  }

  // Returns an error message string if the current step is invalid, or null
  // if it's OK to continue. Kept as pure validation (no DOM/alert side
  // effects) so submitStep can decide how to surface it.
  function validateStep() {
    if (step === 1 && !draft.name) {
      return 'Please enter your name';
    }
    if (step === 2 && !draft.jobSectors.length) {
      return 'Pick at least one industry';
    }
    if (step === 2 && !draft.employmentTypes.length) {
      return 'Pick at least one employment type';
    }
    if (step === 2 && !draft.workModes.length) {
      return 'Pick at least one work mode';
    }
    if (step === 2 && !draft.timeCommitment) {
      return 'Pick how much time you can invest in job hunting';
    }
    if (step === 2 && !draft.workRights) {
      return 'Pick your work rights in Australia';
    }
    if (step === 3) {
      const hasEdu = (draft.education || []).some(e => e.degree || e.institution || e.field);
      if (!hasEdu) {
        return 'Add at least one education entry (degree or institution)';
      }
    }
    if (step === 4) {
      if (!draft.experienceYears) {
        return 'Select your years of experience';
      }
      if (!draft.skills.length) {
        return 'Add at least one key skill';
      }
    }
    if (step === 5 && draft.portfolioRequired && !draft.portfolioUrl) {
      return 'You marked portfolio as required — add a URL or uncheck the box';
    }
    return null;
  }

  async function submitStep() {
    collectStep();
    const error = validateStep();
    if (error) { showObError(error); return; }
    clearObError();

    const btn = document.getElementById('obNext');
    const wasLabel = step === 5 ? 'Finish & start hunting' : 'Continue';

    if (step < 5) {
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        await persistDraft(false);
        step++;
        renderOnboardingStep();
      } catch (err) {
        showObError('Could not save progress: ' + err.message + ' — your entries are kept on this device, try again.');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = wasLabel; }
      }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await persistDraft(true);
      finishBoot();
    } catch (err) {
      showObError(err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Finish & start hunting';
      }
    }
  }

  function finishBoot() {
    syncLocalProfile(session.profile);
    setUserChip();
    hideGate();
    if (onReady) onReady(session);
  }

  async function boot(callback) {
    onReady = callback;
    loadSession();
    showGate();

    if (session?.token) {
      const me = await apiMe();
      if (me) {
        session.profile = { ...defaultProfile(), ...me.profile, email: me.email };
        session.onboardingComplete = me.onboardingComplete;
        saveSession();
        draft = { ...session.profile };
        const needsSetup = profileNeedsOnboarding(session.profile);
        if (session.onboardingComplete && !needsSetup) {
          finishBoot();
          return;
        }
        // Incomplete profile — show full 5-step wizard even if flag was set early.
        if (needsSetup) session.onboardingComplete = false;
        step = inferResumeStep(draft);
        renderOnboardingStep();
        return;
      }
      clearSession();
    }
    setUserChip();
    renderLogin();
  }

  function logout() {
    clearSession();
    setUserChip();
    showLogin();
  }

  async function reopenOnboarding() {
    if (!session) return;
    try {
      await refreshProfile();
    } catch {}
    draft = { ...defaultProfile(), ...session.profile, email: session.email };
    step = inferResumeStep(draft);
    showGate();
    renderOnboardingStep();
  }

  async function refreshProfile() {
    const me = await apiMe();
    if (!me || !session) return getProfile();
    session.profile = { ...defaultProfile(), ...me.profile, email: me.email };
    session.onboardingComplete = me.onboardingComplete;
    saveSession();
    syncLocalProfile(session.profile);
    return session.profile;
  }

  function getSession() { return session; }
  function getProfile() { return session?.profile || defaultProfile(); }
  function isLoggedIn() { return !!(session?.token && session?.onboardingComplete); }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getProfileFormOptions() {
    return {
      employmentTypes: EMPLOYMENT_OPTIONS, workModes: WORK_MODE_OPTIONS,
      timeCommitment: TIME_COMMITMENT_OPTIONS, workRights: WORK_RIGHTS_OPTIONS,
    };
  }

  return {
    boot, logout, deleteAccount, reopenOnboarding, getSession, getProfile, isLoggedIn, showLogin,
    saveProfileToServer, refreshProfile, profileNeedsOnboarding, getProfileFormOptions,
    authHeaders,
  };
})();
