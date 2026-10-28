'use strict';
// UFS Tracker dashboard. Plain JS, no build step. All text is inserted with textContent (never innerHTML).

const TOKEN_KEY = 'tracker.token';
const root = document.getElementById('app');
let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }
let me = null;                 // { user, policy, needsConsent }
let current = 'overview';
let timers = [];

const NOTICE_VERSION_TEXT = 'This tracker records the time you track and, when enabled by your organization, periodic screenshots of the screen or screens specified by organization policy while the tracker is visibly running. It may also count keyboard key-downs and mouse clicks and estimate the number of seconds with input in each minute. It never records key identity, typed text, mouse position, or app and website names. Your manager, HR and administrators can review data according to your organization\'s policy. You can pause or stop tracking at any time. Screenshots are deleted automatically after the retention period. (Draft wording: have HR/legal review before rollout.)';

const isAdmin = () => me && (me.user.role === 'owner' || me.user.role === 'admin');
const isLead = () => me && (isAdmin() || me.user.role === 'manager');
const isReviewer = () => isLead();
// HR reads everyone's time and screenshots but never edits; managers and admins can also review.
const seesOthers = () => isLead() || (me && me.user.role === 'hr');

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && token) { signOutLocal(); throw new Error('Your session expired. Please sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; err.status = res.status; throw err; }
  return data;
}
async function blobUrl(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Could not load image.');
  return URL.createObjectURL(await res.blob());
}
async function download(path, filename) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed.');
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function signOutLocal() { token = null; me = null; try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } renderLogin(); }
function registerTimer(id) { timers.push(id); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

// ---------- login ----------
function renderLogin(message) {
  clearTimers(); clear(root);
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, autofocus: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  // Authenticator code: hidden until the server says this account needs one (admin, HR and owner accounts).
  const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', pattern: '[0-9]{6,8}', id: 'login-totp' });
  const totpField = field('Authenticator code', totp); totpField.classList.add('hidden');
  const intro = h('p', { class: 'muted small' }, 'Time tracking is always visible to you. You can see what is recorded about you here.');
  const emailField = field('Work email', email); const error = h('div', {});
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  // Ask the server how people sign in (wording only; the server enforces everything).
  fetch('/api/auth/config').then(r => r.ok ? r.json() : null).then(cfg => { if (cfg?.signIn === 'ufs-people') { emailField.firstChild.textContent = 'UFS People email'; intro.textContent = 'Sign in with your UFS People account. Time tracking is always visible to you.'; } }).catch(() => {});
  const form = h('form', { onsubmit: async event => {
    event.preventDefault(); clear(error); submit.disabled = true;
    try {
      const body = { email: email.value, password: password.value, kind: 'web' }; if (totp.value.trim()) body.totp = totp.value.trim();
      const data = await api('POST', '/api/auth/login', body);
      token = data.token; try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
      await boot();
    } catch (e) {
      if (e.data?.mfaRequired) { totpField.classList.remove('hidden'); totp.required = true; totp.focus(); error.append(banner('info', e.message)); }
      else error.append(banner('error', e.message));
      submit.disabled = false;
    }
  } }, emailField, field('Password', password), totpField, submit);
  root.append(h('div', { class: 'login' }, h('div', { class: 'card login-card' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'U'), h('div', {}, 'UFS Tracker', h('small', {}, 'TIME & ACTIVITY'))),
    message ? banner('info', message) : null, error, form, intro)));
}

function renderForcedPasswordChange() {
  clearTimers(); clear(root);
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const error = h('div', {});
  root.append(h('div', { class: 'login' }, h('div', { class: 'card login-card' },
    h('h1', {}, 'Choose a new password'), h('p', { class: 'muted' }, 'Your administrator gave you a temporary password. Set your own (10+ characters, with letters and a number).'), error,
    h('form', { onsubmit: async event => {
      event.preventDefault(); clear(error);
      try { await api('POST', '/api/auth/change-password', { currentPassword: cur.value, newPassword: next.value }); await boot(); } catch (e) { error.append(banner('error', e.message)); }
    } }, field('Temporary password', cur), field('New password', next), h('button', { class: 'btn primary', type: 'submit' }, 'Save password')),
    h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out'))));
}
async function logout() { try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ } signOutLocal(); }

// ---------- shell ----------
const NAV = [
  ['overview', 'Overview', () => true],
  ['team', 'Team', () => seesOthers()],
  ['admin', 'Admin portal', () => isAdmin() || (me && me.user.role === 'hr')],
  ['timeline', 'Day view', () => true],
  ['timesheets', 'Timesheets', () => true],
  ['screenshots', 'Screenshots', () => true],
  ['reports', 'Reports', () => true],
  ['payroll', 'Payroll', () => isAdmin() || (me && me.user.role === 'hr')],
  ['projects', 'Projects', () => isLead()],
  ['people', 'People', () => isAdmin()],
  ['policy', 'Policy', () => isAdmin()],
  ['audit', 'Audit log', () => isAdmin()],
  ['integrations', 'Integrations', () => isAdmin()],
  ['privacy', 'Privacy and data', () => true],
  ['account', 'My account', () => true],
];
const VIEWS = {};

function renderShell() {
  clearTimers(); clear(root);
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  watchTables(main); // narrow screens show tables as labelled cards
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.filter(([, , show]) => show()).map(([id, label]) => h('button', { type: 'button', 'data-view': id, 'aria-current': id === current ? 'page' : null, onclick: () => go(id, true) }, icon(id), h('span', {}, label))));
  root.append(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'U'), h('div', {}, 'UFS Tracker', h('small', {}, 'TIME & ACTIVITY'))), nav,
      h('div', { class: 'sidebar-foot' }, h('button', { class: 'btn small bell', type: 'button', id: 'bell', onclick: openNotifications }, icon('bell', 16), ' Notifications ', h('span', { class: 'count hidden', id: 'bell-count' }, '0')), h('div', { class: 'small' }, h('strong', {}, me.user.name)), h('div', { class: 'small muted' }, me.user.role), h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out'))),
    main));
  startBell();
  return main;
}
async function go(id, fromNav = false) {
  current = id; clearTimers();
  document.querySelectorAll('.nav button').forEach(b => b.setAttribute('aria-current', b.dataset.view === id ? 'page' : 'false'));
  const main = document.getElementById('main'); clear(main);
  // Placeholder while the page loads; it disappears as soon as the page adds its first content.
  const placeholder = skeleton(); main.append(placeholder);
  const watcher = new MutationObserver(() => { if ([...main.children].some(child => child !== placeholder)) { placeholder.remove(); watcher.disconnect(); } });
  watcher.observe(main, { childList: true });
  if (fromNav) main.focus({ preventScroll: true }); // keyboard and screen-reader users land on the new page
  try { await VIEWS[id](main); } catch (e) { showError(main, e); }
  placeholder.remove(); watcher.disconnect();
}
function pageHead(title, subtitle, ...toolbar) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'muted small' }, subtitle) : null), h('div', { class: 'toolbar' }, ...toolbar));
}
async function userOptions(includeAll = true) {
  const { users } = await api('GET', '/api/users');
  const opts = users.filter(u => u.active).map(u => [u.id, u.name]);
  return { users, options: includeAll && users.length > 1 ? [['', 'Everyone I can see'], ...opts] : opts };
}
async function projectOptions() {
  const { projects } = await api('GET', '/api/projects');
  return { projects, options: [['', 'No project'], ...projects.filter(p => p.active).map(p => [p.id, p.client ? `${p.name} (${p.client})` : p.name])] };
}
function rangeControls(days = 7) {
  const to = new Date(); const from = new Date(); from.setDate(from.getDate() - (days - 1));
  const fromInput = h('input', { type: 'date', value: dateInputValue(from) }); const toInput = h('input', { type: 'date', value: dateInputValue(to) });
  return { fromInput, toInput, nodes: [h('label', {}, 'From', fromInput), h('label', {}, 'To', toInput)], get: () => rangeFromInputs(fromInput.value, toInput.value) };
}

// ---------- overview ----------
VIEWS.overview = async main => {
  main.append(pageHead(`Hello, ${me.user.name.split(' ')[0]}`, isLead() ? 'Who is tracking right now, and what needs your review.' : seesOthers() ? 'Who is tracking right now, and recent time across the organization.' : 'Your tracking status and recent time.'));
  if (me.needsConsent) main.append(consentBanner());
  const statsHost = h('div', { class: 'stats' }); const liveHost = h('div', { class: 'card' });
  main.append(statsHost, liveHost);
  const refresh = async () => {
    try {
      const [live, pending] = await Promise.all([api('GET', '/api/team/live'), api('GET', `/api/time-entries?status=pending&from=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}`)]);
      const now = new Date(); const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const today = await api('GET', `/api/reports/hours?from=${encodeURIComponent(startOfDay.toISOString())}&to=${encodeURIComponent(new Date(startOfDay.getTime() + 86400000).toISOString())}&groupBy=user&tzOffsetMinutes=${tzOffset()}`);
      clear(statsHost);
      statsHost.append(stat('Tracking now', live.members.filter(m => m.state === 'tracking').length), stat('Hours today', dur(today.total.trackedMs)), stat('Entries awaiting approval', pending.entries.filter(e => e.endAt).length), stat('People', live.members.length));
      clear(liveHost);
      liveHost.append(h('h2', {}, seesOthers() ? 'Team status' : 'My status'));
      if (!live.members.length) { liveHost.append(emptyState('No people to show yet.')); return; }
      liveHost.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Status', 'Working on', 'Tracked this session', 'Last seen'].map(t => h('th', {}, t)))),
        h('tbody', {}, live.members.map(m => h('tr', {},
          h('td', {}, m.name), h('td', {}, h('span', { class: `dot ${m.state}` }), m.state === 'tracking' ? 'Tracking' : m.state === 'paused' ? 'Paused' : 'Offline'),
          h('td', {}, [m.projectName, m.taskLabel].filter(Boolean).join(' · ') || '—'), h('td', {}, m.state === 'offline' ? '—' : dur(m.trackedMs)), h('td', { class: 'muted' }, m.lastSeenAt ? dtShort(m.lastSeenAt) : 'Never')))))));
    } catch (e) { showError(main, e); }
  };
  await refresh(); registerTimer(setInterval(refresh, 15000));
};
function consentBanner() {
  const btn = h('button', { class: 'btn primary small', type: 'button', onclick: async () => { try { await api('POST', '/api/me/consent', { version: me.policy.consentVersion }); me.needsConsent = false; await go(current); } catch (e) { showError(document.getElementById('main'), e); } } }, 'I have read and accept');
  return h('div', { class: 'banner warn' }, h('strong', {}, 'Monitoring notice. '), NOTICE_VERSION_TEXT, h('div', { class: 'dialog-actions' }, btn));
}

// ---------- timesheets ----------
VIEWS.timesheets = async main => {
  const { users, options } = await userOptions(); const { projects, options: projOptions } = await projectOptions();
  const range = rangeControls(7);
  const person = select(options, ''); const status = select([['', 'Any status'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']], '');
  const results = h('div', { class: 'card' });
  const load = async () => {
    const { from, to } = range.get();
    const q = new URLSearchParams({ from, to }); if (person.value) q.set('userId', person.value); if (status.value) q.set('status', status.value);
    clear(results);
    const { entries } = await api('GET', `/api/time-entries?${q}`);
    if (!entries.length) { results.append(emptyState('No time entries in this range.')); return; }
    const pendingReviewable = entries.filter(e => e.status === 'pending' && e.endAt && canReview(e));
    const total = entries.filter(e => e.status !== 'rejected').reduce((t, e) => t + e.trackedMs, 0);
    results.append(h('div', { class: 'page-head' }, h('h2', {}, `${entries.length} entries · ${dur(total)} counted`),
      pendingReviewable.length ? h('button', { class: 'btn small', type: 'button', onclick: async ev => { ev.target.disabled = true; try { for (const e of pendingReviewable) await api('POST', `/api/time-entries/${e.id}/approve`, {}); await load(); } catch (err) { showError(main, err); } } }, `Approve all ${pendingReviewable.length} pending`) : null));
    results.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Date', 'Time', 'Project / task', 'Tracked', 'Idle (est.)', 'Activity estimate', 'Source', 'Status', ''].map((t, i) => h('th', { class: i === 4 || i === 5 || i === 6 ? 'num' : '' }, t)))),
      h('tbody', {}, entries.map(e => h('tr', {},
        h('td', {}, e.userName), h('td', {}, dayLabel(e.startAt)), h('td', {}, `${timeOnly(e.startAt)}${e.endAt ? ' – ' + timeOnly(e.endAt) : ' – running'}`),
        h('td', { class: 'wrap' }, [e.projectName, e.taskLabel].filter(Boolean).join(' · ') || '—', e.edited ? h('span', {}, ' ', badge('edited', 'info')) : null),
        h('td', { class: 'num' }, dur(e.trackedMs)), h('td', { class: 'num muted' }, dur(e.idleMs)), h('td', { class: 'num muted', title: 'Estimate from keyboard and mouse counts; not a measure of productivity.' }, e.activityPercent === null ? '—' : `${e.activityPercent}%`), h('td', {}, e.source), h('td', {}, statusBadge(e.status)),
        h('td', {}, h('div', { class: 'actions' },
          e.endAt && e.status !== 'approved' && canReview(e) ? h('button', { class: 'btn small', type: 'button', onclick: () => review(e, 'approve') }, 'Approve') : null,
          e.endAt && e.status !== 'rejected' && canReview(e) ? h('button', { class: 'btn small', type: 'button', onclick: () => review(e, 'reject') }, 'Reject') : null,
          e.endAt && canEdit(e) ? h('button', { class: 'btn small', type: 'button', onclick: () => editDialog(e) }, 'Edit') : null,
          canDelete(e) ? h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteEntry(e) }, 'Delete') : null))))))));
  };
  const canReview = e => isAdmin() ? (e.userId !== me.user.id || me.user.role === 'owner') : (me.user.role === 'manager' && e.userId !== me.user.id);
  const canEdit = e => e.userId === me.user.id ? (e.source === 'manual' && e.status === 'pending') : (canReview(e) && (e.status !== 'approved' || isAdmin()));
  const canDelete = e => (e.userId === me.user.id && e.source === 'manual' && e.status === 'pending') || isAdmin();
  const safe = fn => async (...args) => { try { await fn(...args); } catch (e) { showError(main, e); } };
  const review = safe(async (e, verb) => { await api('POST', `/api/time-entries/${e.id}/${verb}`, {}); await load(); });
  const deleteEntry = safe(async e => { if (confirm('Delete this time entry? This is recorded in the audit log.')) { await api('DELETE', `/api/time-entries/${e.id}`); await load(); } });

  const editDialog = e => {
    const own = e.userId === me.user.id;
    const start = h('input', { type: 'datetime-local', value: localInputValue(e.startAt), required: true }); const end = h('input', { type: 'datetime-local', value: localInputValue(e.endAt), required: true });
    const projectSel = select(projOptions, e.projectId || ''); const label = h('input', { type: 'text', maxlength: '120', value: e.taskLabel });
    const minutes = e.source === 'tracker' ? h('input', { type: 'number', min: '0', value: String(Math.round(e.trackedMs / 60000)) }) : null;
    const reason = !own ? h('textarea', { placeholder: 'Why are you changing this? (recorded in the audit log)', required: true }) : null;
    const dlg = dialog('Edit time entry', [h('div', { class: 'field-row' }, field('Start', start), field('End', end)), field('Project', projectSel), field('Task / note', label), minutes ? field('Tracked minutes', minutes) : null, reason ? field('Reason', reason) : null], { actions: [] });
    const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try {
        const body = { startAt: new Date(start.value).toISOString(), endAt: new Date(end.value).toISOString(), projectId: projectSel.value || null, taskLabel: label.value };
        if (minutes) body.trackedMs = Math.round(Number(minutes.value) * 60000); if (reason) body.reason = reason.value;
        await api('PATCH', `/api/time-entries/${e.id}`, body); dlg.close(); await load();
      } catch (err) { dlg.fail(err); }
    } }, 'Save');
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), save);
  };
  const addDialog = () => {
    const now = new Date(); const startDefault = new Date(now.getTime() - 3600000);
    const start = h('input', { type: 'datetime-local', value: localInputValue(startDefault.toISOString()), required: true }); const end = h('input', { type: 'datetime-local', value: localInputValue(now.toISOString()), required: true });
    const projectSel = select(projOptions, ''); const label = h('input', { type: 'text', maxlength: '120', placeholder: 'What did you work on?' }); const note = h('textarea', { placeholder: 'Optional note for your manager' });
    const dlg = dialog('Add manual time', [h('p', { class: 'muted small' }, 'Manual time is marked as manual and needs manager approval.'), h('div', { class: 'field-row' }, field('Start', start), field('End', end)), field('Project', projectSel), field('Task', label), field('Note', note)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { await api('POST', '/api/time-entries', { startAt: new Date(start.value).toISOString(), endAt: new Date(end.value).toISOString(), projectId: projectSel.value || null, taskLabel: label.value, note: note.value || undefined }); dlg.close(); await load(); } catch (err) { dlg.fail(err); }
    } }, 'Add time'));
  };
  const apply = h('button', { class: 'btn primary', type: 'button', onclick: () => load().catch(e => showError(main, e)) }, 'Apply');
  main.append(pageHead('Timesheets', 'Review, approve and correct tracked time.', ...range.nodes, users.length > 1 ? h('label', {}, 'Person', person) : null, h('label', {}, 'Status', status), apply, h('button', { class: 'btn', type: 'button', onclick: addDialog }, 'Add manual time')), results);
  void projects; await load();
};

// ---------- screenshots ----------
const bytesLabel = n => { n = Number(n) || 0; if (n < 1024) return `${n} B`; const units = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1); return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`; };
const dateOnly = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

VIEWS.screenshots = async main => {
  const { users, options } = await userOptions(); const { options: projectOpts } = await projectOptions();
  const range = rangeControls(3); const person = select(options, '');
  const project = select([['', 'Any project'], ...projectOpts.filter(([v]) => v)], '');
  const groupBy = select([['day', 'Group by day'], ['person', 'Group by person']], 'day');
  const canDelete = isLead() || (me.user.role !== 'hr' && me.policy.allowEmployeeDelete);
  const summaryHost = h('div', {}), barHost = h('div', {}), host = h('div', {}), more = h('div', { class: 'load-more' });
  let shots = [], hasMore = false, selecting = false; const selected = new Set();
  const observer = new IntersectionObserver(entries => entries.forEach(async entry => {
    if (!entry.isIntersecting) return; observer.unobserve(entry.target);
    try { entry.target.src = await blobUrl(`/api/screenshots/${entry.target.dataset.id}/${entry.target.dataset.thumb === '1' ? 'thumb' : 'image'}`); } catch { entry.target.alt = 'Image unavailable'; }
  }), { rootMargin: '200px' });

  const loadSummary = async () => {
    clear(summaryHost);
    const s = await api('GET', '/api/screenshots/summary?days=14');
    const oldest = s.byUser.map(x => x.oldestAt).filter(Boolean).sort()[0];
    summaryHost.append(h('div', { class: 'stats' }, stat('Screenshots you can see', s.total.count.toLocaleString()), stat('Storage used', bytesLabel(s.total.bytes)), stat('Average size', s.total.count ? bytesLabel(s.total.bytes / s.total.count) : '—'), stat('Oldest', dateOnly(oldest)), stat('Auto-delete after', `${s.retentionDays} days`)));
    if (s.byUser.length > 1) {
      const max = Math.max(1, ...s.byUser.map(x => x.bytes));
      summaryHost.append(h('details', { class: 'card' }, h('summary', {}, `Storage by person (${s.byUser.length})`), h('div', { class: 'bars' }, s.byUser.slice(0, 12).map(x => h('div', { class: 'bar-row' }, h('span', {}, x.name), h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${Math.max(2, Math.round(x.bytes / max * 100))}%` })), h('span', { class: 'num' }, `${x.count} · ${bytesLabel(x.bytes)}`))))));
    }
  };

  const query = before => { const { from, to } = range.get(); const q = new URLSearchParams({ from, to, limit: '60' }); if (person.value) q.set('userId', person.value); if (project.value) q.set('projectId', project.value); if (before) q.set('before', before); return q; };
  const render = () => {
    clear(host); clear(barHost); clear(more);
    const delBtn = h('button', { class: 'btn danger small', type: 'button', disabled: selected.size === 0, onclick: () => deleteSelected() }, `Delete selected (${selected.size})`);
    if (canDelete && shots.length) barHost.append(h('div', { class: 'select-bar' },
      h('button', { class: `btn small${selecting ? ' primary' : ''}`, type: 'button', onclick: () => { selecting = !selecting; selected.clear(); render(); } }, selecting ? 'Done selecting' : 'Select'),
      selecting ? h('button', { class: 'btn small', type: 'button', onclick: () => { for (const s of shots) selected.add(s.id); render(); } }, `Select all ${shots.length} shown`) : null,
      selecting ? h('button', { class: 'btn small', type: 'button', disabled: selected.size === 0, onclick: () => { selected.clear(); render(); } }, 'Clear') : null, selecting ? delBtn : null));
    if (!shots.length) { host.append(h('div', { class: 'card' }, emptyState('No screenshots match these filters, or you do not have access to them.'))); return; }
    host.append(h('p', { class: 'muted small' }, `${shots.length} shown${hasMore ? ' (more available)' : ''}. Viewing someone else's screenshot is recorded in the audit log.`));
    const grid = h('div', { class: 'grid' }); let lastGroup = null;
    const sorted = groupBy.value === 'person' ? [...shots].sort((a, b) => a.userName.localeCompare(b.userName) || b.takenAt.localeCompare(a.takenAt)) : shots;
    for (const s of sorted) {
      const img = h('img', { class: 'img', alt: `Screenshot by ${s.userName} at ${dtShort(s.takenAt)}`, 'data-id': s.id, 'data-thumb': s.hasThumb ? '1' : '0' });
      const group = groupBy.value === 'person' ? s.userName : dayLabel(s.takenAt);
      if (group !== lastGroup) { lastGroup = group; grid.append(h('h3', { class: 'day-head' }, group)); }
      const card = h('button', { class: `shot${selected.has(s.id) ? ' selected' : ''}`, type: 'button', 'aria-pressed': selecting ? String(selected.has(s.id)) : null, onclick: () => { if (selecting) { selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id); render(); } else openShot(shots.indexOf(s)); } },
        img, selecting ? h('span', { class: 'tick' }, selected.has(s.id) ? '✓' : '') : null, h('div', { class: 'cap' }, h('strong', {}, s.userName), groupBy.value === 'person' ? dtShort(s.takenAt) : `${timeOnly(s.takenAt)} · ${bytesLabel(s.bytes)}`));
      grid.append(card); observer.observe(img);
    }
    host.append(grid);
    if (hasMore) more.append(h('button', { class: 'btn', type: 'button', onclick: async ev => { ev.target.disabled = true; try { await loadMore(); } catch (e) { showError(main, e); } } }, 'Load more'));
  };
  const load = async () => {
    selected.clear(); const res = await api('GET', `/api/screenshots?${query()}`); shots = res.screenshots; hasMore = res.hasMore; render();
    await loadSummary().catch(() => {});
  };
  const loadMore = async () => { const res = await api('GET', `/api/screenshots?${query(shots.at(-1).takenAt)}`); shots = shots.concat(res.screenshots); hasMore = res.hasMore; render(); };

  const deleteSelected = () => {
    const ids = [...selected]; if (!ids.length) return;
    const reason = h('input', { type: 'text', maxlength: '200', placeholder: 'Optional reason (recorded in the audit log)' });
    const dlg = dialog(`Delete ${ids.length} screenshot${ids.length === 1 ? '' : 's'}?`, [h('p', {}, 'The images are removed from storage and cannot be restored. Each deletion is recorded in the audit log.'), field('Reason', reason)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn danger', type: 'button', onclick: async ev => {
      ev.target.disabled = true;
      try {
        let deleted = 0; const skipped = [];
        for (let i = 0; i < ids.length; i += 100) { const r = await api('POST', '/api/screenshots/bulk-delete', { ids: ids.slice(i, i + 100), reason: reason.value || undefined }); deleted += r.deleted; skipped.push(...r.skipped); }
        dlg.close(); selecting = false; await load();
        toast(skipped.length ? `Deleted ${deleted}; ${skipped.length} could not be deleted (${skipped[0].reason})` : `Deleted ${deleted} screenshot${deleted === 1 ? '' : 's'}.`, skipped.length ? 'warn' : 'ok');
      } catch (e) { ev.target.disabled = false; dlg.fail(e); }
    } }, 'Delete permanently'));
  };

  // Full-size viewer with previous/next (also with the arrow keys) over everything loaded so far.
  const openShot = async index => {
    let i = index; const s0 = shots[i]; if (!s0) return;
    const img = h('img', { class: 'full', alt: '' }); const meta = h('p', { class: 'muted small' }); const title = h('span', {});
    const dlg = dialog('', [img, meta], { wide: true }); dlg.querySelector('h2').append(title);
    const actions = dlg.querySelector('.dialog-actions');
    const prev = h('button', { class: 'btn', type: 'button', onclick: () => show(i - 1) }, '← Newer'), next = h('button', { class: 'btn', type: 'button', onclick: () => show(i + 1) }, 'Older →');
    const del = h('button', { class: 'btn danger', type: 'button', onclick: async () => { const s = shots[i]; if (!confirm('Delete this screenshot permanently?')) return; try { await api('DELETE', `/api/screenshots/${s.id}`); dlg.close(); await load(); } catch (e) { dlg.fail(e); } } }, 'Delete screenshot');
    const save = h('button', { class: 'btn', type: 'button', onclick: async () => { const s = shots[i]; try { await download(`/api/screenshots/${s.id}/image`, `screenshot-${s.userName.replace(/\W+/g, '-')}-${s.takenAt.slice(0, 19).replace(/[:T]/g, '-')}.${s.format}`); } catch (e) { dlg.fail(e); } } }, 'Download');
    actions.append(prev, next, save); actions.append(h('span', { class: 'spacer' })); if (canDelete) actions.append(del); actions.append(h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close'));
    const keys = ev => { if (ev.key === 'ArrowLeft') show(i - 1); else if (ev.key === 'ArrowRight') show(i + 1); };
    dlg.addEventListener('keydown', keys);
    async function show(n) {
      if (n < 0 || n >= shots.length) return; i = n; const s = shots[i];
      const own = s.userId === me.user.id; del.hidden = !(own ? me.policy.allowEmployeeDelete : isLead());
      title.textContent = `${s.userName} · ${dtShort(s.takenAt)}`; meta.textContent = `${s.width} × ${s.height} px · ${s.format.toUpperCase()} · ${bytesLabel(s.bytes)} · ${i + 1} of ${shots.length}${hasMore && i === shots.length - 1 ? '+' : ''}`;
      prev.disabled = i === 0; next.disabled = i === shots.length - 1 && !hasMore; img.alt = `Screenshot by ${s.userName} at ${dtShort(s.takenAt)}`;
      if (i === shots.length - 1 && hasMore) { try { await loadMore(); next.disabled = false; meta.textContent = meta.textContent.replace(/\+$/, ''); } catch { /* keep what is loaded */ } }
      try { const url = await blobUrl(`/api/screenshots/${s.id}/image`); if (shots[i] === s) { URL.revokeObjectURL(img.src); img.src = url; } } catch (e) { dlg.fail(e); }
    }
    await show(i);
  };

  const apply = h('button', { class: 'btn primary', type: 'button', onclick: () => load().catch(e => showError(main, e)) }, 'Apply');
  groupBy.addEventListener('change', render);
  main.append(pageHead('Screenshots', 'Screenshots are only captured while the tracker is visibly running.', ...range.nodes, users.length > 1 ? h('label', {}, 'Person', person) : null, h('label', {}, 'Project', project), h('label', {}, 'View', groupBy), apply), summaryHost, barHost, host, more);
  await load();
};

// ---------- admin portal ----------
/** A small accessible bar chart: rows = [{label, value, title}]. Drawn with SVG, no libraries. */
function barChart(rows, { label, format = v => String(v), height = 170 }) {
  const width = 640, pad = { l: 44, r: 8, t: 10, b: 26 }, max = Math.max(1, ...rows.map(r => r.value));
  const bw = (width - pad.l - pad.r) / Math.max(1, rows.length);
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': `${label}: ${rows.map(r => `${r.label} ${format(r.value)}`).join(', ')}` });
  for (const f of [0, .5, 1]) {
    const y = pad.t + (height - pad.t - pad.b) * (1 - f);
    chart.append(svg('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, class: 'grid-line' }), svg('text', { x: pad.l - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }, document.createTextNode(format(max * f))));
  }
  const step = Math.ceil(rows.length / 7);
  rows.forEach((r, i) => {
    const bh = (height - pad.t - pad.b) * (r.value / max), x = pad.l + i * bw + bw * .15, y = height - pad.b - bh;
    chart.append(svg('rect', { x, y, width: bw * .7, height: Math.max(r.value > 0 ? 2 : 0, bh), rx: 3, class: 'bar-fill-svg' }, svg('title', {}, document.createTextNode(r.title || `${r.label}: ${format(r.value)}`))));
    if (i % step === 0 || i === rows.length - 1) chart.append(svg('text', { x: x + bw * .35, y: height - 8, class: 'axis', 'text-anchor': 'middle' }, document.createTextNode(r.label)));
  });
  return chart;
}
const shortDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hoursOf = ms => Math.round(ms / 360000) / 10;

VIEWS.admin = async main => {
  const days = select([['14', 'Last 14 days'], ['30', 'Last 30 days'], ['60', 'Last 60 days']], '14');
  const host = h('div', {});
  const load = async () => {
    clear(host);
    const o = await api('GET', `/api/admin/overview?days=${days.value}&tzOffsetMinutes=${tzOffset()}`);
    if (o.alerts.length) host.append(h('div', { class: 'card' }, h('h2', {}, 'Needs your attention'), h('ul', { class: 'alerts' }, o.alerts.map(a => h('li', { class: a.level }, h('span', {}, a.text), a.view && NAV.some(([id, , show]) => id === a.view && show()) ? h('button', { class: 'btn small', type: 'button', onclick: () => go(a.view) }, 'Open') : null)))));
    else host.append(h('div', { class: 'banner ok' }, 'Nothing needs attention right now.'));
    host.append(h('div', { class: 'stats' },
      stat('Tracking now', `${o.people.live.tracking}`), stat('Paused / offline', `${o.people.live.paused} / ${o.people.live.offline}`), stat('Hours today', dur(o.time.todayMs)), stat('Hours, last 7 days', dur(o.time.last7Ms)),
      stat('Awaiting approval', `${o.approvals.pending}`), stat('People', `${o.people.active}`), stat('Screenshots stored', o.screenshots.total.toLocaleString()), stat('Storage used', bytesLabel(o.screenshots.bytes))));
    host.append(h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', {}, 'Tracked hours per day'), barChart(o.time.trend.map(d => ({ label: shortDay(d.date), value: hoursOf(d.trackedMs), title: `${shortDay(d.date)}: ${dur(d.trackedMs)} tracked, ${dur(d.idleMs)} idle (estimate)` })), { label: 'Tracked hours per day', format: v => `${Math.round(v * 10) / 10}h` })),
      h('div', { class: 'card' }, h('h2', {}, 'Screenshots per day'), barChart(o.screenshots.trend.map(d => ({ label: shortDay(d.date), value: d.count, title: `${shortDay(d.date)}: ${d.count} screenshots, ${bytesLabel(d.bytes)}` })), { label: 'Screenshots per day', format: v => String(Math.round(v)) }))));
    const bars = (title, rows) => { const max = Math.max(1, ...rows.map(r => r.trackedMs)); return h('div', { class: 'card' }, h('h2', {}, title), rows.length ? h('div', { class: 'bars' }, rows.map(r => h('div', { class: 'bar-row' }, h('span', {}, r.name), h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${Math.max(2, Math.round(r.trackedMs / max * 100))}%` })), h('span', { class: 'num' }, dur(r.trackedMs))))) : emptyState('No tracked time in this period.')); };
    host.append(h('div', { class: 'cols' }, bars('Most tracked time (people)', o.time.topPeople), bars('Tracked time by project', o.time.byProject)));
    const s = o.screenshots;
    host.append(h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', {}, 'Screenshot storage and retention'),
        h('dl', { class: 'facts' }, ...[['Stored', `${s.total.toLocaleString()} screenshots · ${bytesLabel(s.bytes)}`], ['Image format', s.imageFormat.toUpperCase()], ['Auto-delete after', `${s.retentionDays} days`], ['Oldest', dateOnly(s.oldestAt)], ['Newest', s.newestAt ? dtShort(s.newestAt) : '—'], ['Last automatic purge', s.lastPurgeAt ? dtShort(s.lastPurgeAt) : 'None yet']].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        s.topStorage.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Largest storage', 'Screenshots', 'Size'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))), h('tbody', {}, s.topStorage.map(x => h('tr', {}, h('td', {}, x.name), h('td', { class: 'num' }, x.count.toLocaleString()), h('td', { class: 'num' }, bytesLabel(x.bytes))))))) : null,
        h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('screenshots') }, 'Manage screenshots'))),
      h('div', { class: 'card' }, h('h2', {}, 'System and activity'),
        h('dl', { class: 'facts' }, ...[
          ['UFS People directory', o.directory.enabled ? `${o.directory.host} · last sync ${o.directory.lastStatus ?? 'none'}${o.directory.lastSuccessAt ? ` (ok ${dtShort(o.directory.lastSuccessAt)})` : ''}` : 'Not connected (local accounts only)'],
          ['People from the directory', `${o.people.fromDirectory} of ${o.people.active}`], ['Signed-in devices', `${o.devices.active} active · ${o.devices.stale} unseen for 14 days`],
          ['Accepted current notice', `${o.people.active - o.people.withoutConsent} of ${o.people.active}`], ['Audit events, last 24 h', `${o.audit.last24h} (${o.audit.views24h} screenshot views, ${o.audit.deletions24h} deletions)`]].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => go('audit') }, 'Open audit log'), h('button', { class: 'btn', type: 'button', onclick: () => go('people') }, 'Open people')))));
    host.append(h('p', { class: 'muted small' }, `${o.note} Updated ${dtShort(o.generatedAt)}.`));
  };
  main.append(pageHead('Admin portal', 'Organization-wide numbers: people, time, approvals, screenshots and system health.', h('label', {}, 'Period', days), h('button', { class: 'btn primary', type: 'button', onclick: () => load().catch(e => showError(main, e)) }, 'Refresh')), host);
  days.addEventListener('change', () => load().catch(e => showError(main, e)));
  await load(); registerTimer(setInterval(() => load().catch(() => {}), 60000));
};

// ---------- notifications (bell in the sidebar) ----------
let bellTimer = null, lastUnread = null;
async function refreshBell() {
  const el = document.getElementById('bell-count'); if (!el) return;
  try {
    const { unread } = await api('GET', '/api/notifications?limit=1');
    el.textContent = unread > 99 ? '99+' : String(unread); el.classList.toggle('hidden', unread === 0);
    if (lastUnread !== null && unread > lastUnread) toast('You have a new notification.', 'ok');
    lastUnread = unread;
  } catch { /* the next poll retries */ }
}
function startBell() { clearInterval(bellTimer); lastUnread = null; refreshBell(); bellTimer = setInterval(refreshBell, 60000); }
async function openNotifications() {
  const list = h('div', { class: 'notes' }); const dlg = dialog('Notifications', [list], { wide: false });
  const markAll = h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('POST', '/api/notifications/read', { all: true }); await show(); refreshBell(); } catch (e) { dlg.fail(e); } } }, 'Mark all as read');
  dlg.querySelector('.dialog-actions').append(markAll, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close'));
  async function show() {
    clear(list); const { notifications } = await api('GET', '/api/notifications?limit=40');
    if (!notifications.length) { list.append(emptyState('Nothing yet.', 'Approvals, edits and requests will appear here.')); return; }
    for (const n of notifications) {
      const open = async () => { try { if (!n.readAt) await api('POST', '/api/notifications/read', { ids: [n.id] }); } catch { /* still navigate */ } dlg.close(); refreshBell(); if (n.link && NAV.some(([id, , showItem]) => id === n.link && showItem())) go(n.link, true); };
      list.append(h('button', { class: `note${n.readAt ? '' : ' unread'}`, type: 'button', onclick: open }, h('strong', {}, n.title), n.body ? h('span', { class: 'small' }, n.body) : null, h('span', { class: 'muted small' }, dtShort(n.createdAt))));
    }
  }
  try { await show(); } catch (e) { dlg.fail(e); }
}

// ---------- payroll ----------
VIEWS.payroll = async main => {
  const canSet = isAdmin(); const range = rangeControls(30);
  const ratesHost = h('div', { class: 'card' }), exportHost = h('div', {});
  const loadRates = async () => {
    clear(ratesHost); const { people } = await api('GET', '/api/payroll/rates');
    ratesHost.append(h('h2', {}, 'Pay rates'), h('p', { class: 'muted small' }, 'Hourly rates by effective date. The rate in force on the day an entry started is used. Only owners and admins can change rates; HR can view them. Changes are audited (the amounts are not copied into the audit log).'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Role', 'Current rate', 'Changes', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, people.map(p => h('tr', {}, h('td', {}, p.name), h('td', {}, p.role), h('td', {}, p.current ? `${p.current.hourlyRate} ${p.current.currency}/h (from ${p.current.effectiveFrom})` : h('span', { class: 'muted' }, 'Not set')), h('td', { class: 'num' }, p.changes), h('td', { class: 'actions-cell' }, canSet ? h('button', { class: 'btn small', type: 'button', onclick: () => rateDialog(p) }, 'Set rate') : null)))))));
  };
  const rateDialog = p => {
    const rate = h('input', { type: 'number', min: '0', max: '10000', step: '0.01', required: true, value: p.current?.hourlyRate ?? '' });
    const currency = h('input', { type: 'text', maxlength: '3', value: p.current?.currency ?? 'USD', style: 'text-transform:uppercase' });
    const from = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }); // rates and payroll use UTC dates
    const dlg = dialog(`Pay rate for ${p.name}`, [h('p', { class: 'muted small' }, 'A new rate applies to time that starts on or after the date (UTC). Earlier approved time keeps its earlier rate.'), h('div', { class: 'field-row' }, field('Hourly rate', rate), field('Currency (3 letters)', currency)), field('Effective from (UTC date)', from)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', '/api/payroll/rates', { userId: p.userId, hourlyRate: Number(rate.value), currency: currency.value.toUpperCase(), effectiveFrom: from.value }); dlg.close(); toast('Pay rate saved.'); await loadRates(); } catch (e) { dlg.fail(e); } } }, 'Save rate'));
  };
  const preview = async () => {
    clear(exportHost); const { from, to } = range.get();
    const r = await api('GET', `/api/payroll/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    exportHost.append(h('div', { class: 'card' }, h('h2', {}, `Payroll preview · ${r.people.length} people`),
      r.missingRateCount ? h('div', { class: 'banner warn' }, `${r.missingRateCount} ${r.missingRateCount === 1 ? 'person has' : 'people have'} approved time but no pay rate for it.`) : null,
      h('div', { class: 'stats' }, ...Object.entries(r.totals).map(([c, v]) => stat(`Total (${c})`, v)), stat('People with approved time', String(r.people.filter(x => x.approvedHours > 0).length))),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Approved hours', 'Rate', 'Amount', 'Pending hours (not included)'].map((t, i) => h('th', { class: i && i !== 2 ? 'num' : '' }, t)))),
        h('tbody', {}, r.people.map(l => h('tr', {}, h('td', {}, l.name), h('td', { class: 'num' }, l.approvedHours), h('td', {}, l.lines.length ? l.lines.map(x => `${x.hourlyRate} ${x.currency}`).join(', ') : h('span', { class: 'muted' }, l.missingRate ? 'No rate' : '—')), h('td', { class: 'num' }, l.lines.length ? l.lines.map(x => `${x.amount} ${x.currency}`).join(' + ') : '—'), h('td', { class: 'num muted' }, l.pendingHours)))))),
      h('p', { class: 'muted small' }, r.note)));
  };
  const csv = async () => { const { from, to } = range.get(); await download(`/api/payroll/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=csv`, 'payroll-export.csv'); toast('CSV downloaded. This export is recorded in the audit log.'); };
  main.append(pageHead('Payroll', 'Approved time multiplied by the pay rates below. A working sheet, not payroll advice.', ...range.nodes, h('button', { class: 'btn primary', type: 'button', onclick: () => preview().catch(e => showError(main, e)) }, 'Preview'), h('button', { class: 'btn', type: 'button', onclick: () => csv().catch(e => showError(main, e)) }, 'Download CSV')), exportHost, ratesHost);
  await loadRates(); await preview().catch(e => showError(main, e));
};

// ---------- privacy and my data ----------
VIEWS.privacy = async main => {
  main.append(pageHead('Privacy and my data', 'See, download or ask to delete what this tracker holds about you.'));
  const mine = h('div', { class: 'card' });
  const loadMine = async () => {
    clear(mine); const { requests } = await api('GET', '/api/me/data-requests');
    const open = requests.find(x => x.status === 'open');
    mine.append(h('h2', {}, 'My data'), h('p', { class: 'muted small' }, 'The download is a JSON file with your profile, time entries, daily activity counts (if enabled), screenshot list, devices and who has looked at your screenshots and activity. Screenshot images are downloaded from the Screenshots page.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await download('/api/me/export', `my-tracker-data-${dateInputValue(new Date())}.json`); toast('Your data was downloaded.'); } catch (e) { showError(main, e); } } }, 'Download my data'),
        h('button', { class: 'btn', type: 'button', disabled: !!open, onclick: requestDialog }, open ? 'Deletion request pending' : 'Ask to delete my screenshots and activity data')),
      h('p', { class: 'muted small' }, 'Deleting removes your screenshots and keyboard/mouse counts. Your time entries stay because payroll depends on them. An administrator reviews the request.'),
      requests.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Requested', 'Status', 'Decision'].map(t => h('th', {}, t)))), h('tbody', {}, requests.map(x => h('tr', {}, h('td', {}, dtShort(x.createdAt)), h('td', {}, badge(x.status, x.status === 'fulfilled' ? 'ok' : x.status === 'declined' ? 'bad' : 'warn')), h('td', { class: 'wrap' }, x.resolutionNote || (x.resolvedAt ? `Resolved ${dtShort(x.resolvedAt)}` : 'Waiting for an administrator'))))))) : null);
  };
  const requestDialog = () => {
    const text = h('textarea', { maxlength: '500', placeholder: 'Optional: tell the administrator why' });
    const dlg = dialog('Ask to delete my screenshots and activity data', [h('p', { class: 'muted small' }, 'Your time entries are kept for payroll. An administrator will review this and you will be notified.'), field('Note', text)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { await api('POST', '/api/me/data-requests', { note: text.value || undefined }); dlg.close(); toast('Request sent.'); await loadMine(); } catch (e) { dlg.fail(e); } } }, 'Send request'));
  };
  main.append(mine); await loadMine();
  if (isAdmin() || me.user.role === 'hr') {
    const queue = h('div', { class: 'card' }); main.append(queue);
    const loadQueue = async () => {
      clear(queue); const { requests } = await api('GET', '/api/admin/data-requests');
      queue.append(h('h2', {}, `Deletion requests (${requests.filter(x => x.status === 'open').length} open)`));
      if (!requests.length) { queue.append(emptyState('No deletion requests.')); return; }
      queue.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Requested', 'Note', 'Status', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, requests.map(x => h('tr', {}, h('td', {}, x.userName), h('td', {}, dtShort(x.createdAt)), h('td', { class: 'wrap' }, x.note || '—'), h('td', {}, badge(x.status, x.status === 'fulfilled' ? 'ok' : x.status === 'declined' ? 'bad' : 'warn')),
          h('td', { class: 'actions-cell' }, x.status === 'open' && isAdmin() ? h('div', { class: 'actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: () => resolve(x, 'fulfil') }, 'Delete data'), h('button', { class: 'btn small', type: 'button', onclick: () => resolve(x, 'decline') }, 'Decline')) : null)))))));
    };
    const resolve = (x, action) => {
      const note = h('textarea', { maxlength: '300', placeholder: action === 'decline' ? 'Why is this declined? (the person is told)' : 'Optional note' });
      const dlg = dialog(action === 'fulfil' ? `Delete ${x.userName}'s screenshots and activity data?` : 'Decline this request', [h('p', { class: action === 'fulfil' ? '' : 'muted small' }, action === 'fulfil' ? 'Screenshots and keyboard/mouse counts are removed for good. Time entries stay. This is recorded in the audit log.' : 'The person will see your reason.'), field('Note', note)]);
      dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: `btn ${action === 'fulfil' ? 'danger' : 'primary'}`, type: 'button', onclick: async () => { try { const r = await api('POST', `/api/admin/data-requests/${x.id}/resolve`, { action, note: note.value || undefined }); dlg.close(); toast(action === 'fulfil' ? `Deleted ${r.removed.screenshots} screenshots and ${r.removed.activitySlices} activity samples.` : 'Request declined.'); await loadQueue(); } catch (e) { dlg.fail(e); } } }, action === 'fulfil' ? 'Delete permanently' : 'Decline request'));
    };
    await loadQueue();
  }
};

// ---------- day view (timeline) ----------
let timelineTarget = null; // { userId, date } set by links from other pages
const addDays = (dateText, n) => { const d = new Date(`${dateText}T12:00:00`); d.setDate(d.getDate() + n); return dateInputValue(d); };

/** 24-hour bar: one block per time entry (coloured by approval status) and a tick for every screenshot. */
function dayBar(t) {
  const W = 960, H = 100, padL = 8, padR = 8, start = Date.parse(t.dayStartAt), span = Date.parse(t.dayEndAt) - start, inner = W - padL - padR;
  const x = ms => padL + Math.min(1, Math.max(0, (ms - start) / span)) * inner;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart daybar', role: 'img', 'aria-label': `${t.person.name} on ${t.date}: ${t.entries.length} time blocks, ${dur(t.totals.trackedMs)} tracked${t.screenshots ? `, ${t.screenshots.length} screenshots` : ''}` });
  for (let hour = 0; hour <= 24; hour += 3) { const gx = padL + inner * hour / 24; chart.append(svg('line', { x1: gx, x2: gx, y1: 8, y2: 52, class: 'grid-line' }), svg('text', { x: gx, y: 86, class: 'axis', 'text-anchor': hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle' }, document.createTextNode(`${String(hour % 24).padStart(2, '0')}:00`))); }
  for (const e of t.entries) {
    const from = Date.parse(e.startAt), to = e.endAt ? Date.parse(e.endAt) : Math.min(Date.parse(t.dayEndAt), Date.now());
    chart.append(svg('rect', { x: x(from), y: 14, width: Math.max(3, x(to) - x(from)), height: 30, rx: 4, class: `block ${e.running ? 'running' : e.status}` }, svg('title', {}, document.createTextNode(`${timeOnly(e.startAt)}${e.endAt ? ' – ' + timeOnly(e.endAt) : ' – running'} · ${dur(e.trackedMs)} · ${e.status}${e.projectName ? ' · ' + e.projectName : ''}`))));
  }
  for (const b of t.breaks || []) { const from = Date.parse(b.startAt), to = b.endAt ? Date.parse(b.endAt) : Math.min(Date.parse(t.dayEndAt), Date.now()); chart.append(svg('rect', { x: x(from), y: 10, width: Math.max(3, x(to) - x(from)), height: 38, rx: 3, class: 'break' }, svg('title', {}, document.createTextNode(`Break ${timeOnly(b.startAt)}${b.endAt ? ' – ' + timeOnly(b.endAt) : ' – still going'}`)))); }
  for (const s of t.screenshots || []) chart.append(svg('line', { x1: x(Date.parse(s.takenAt)), x2: x(Date.parse(s.takenAt)), y1: 48, y2: 58, class: 'shot-tick' }, svg('title', {}, document.createTextNode(`Screenshot at ${timeOnly(s.takenAt)}`))));
  return chart;
}

VIEWS.timeline = async main => {
  const { users, options } = await userOptions(false);
  const target = timelineTarget || { userId: me.user.id, date: dateInputValue(new Date()) }; timelineTarget = null;
  const person = select(options, users.some(u => u.id === target.userId) ? target.userId : me.user.id);
  const dateInput = h('input', { type: 'date', value: target.date });
  const host = h('div', {});
  const imgObserver = new IntersectionObserver(items => items.forEach(async item => {
    if (!item.isIntersecting) return; imgObserver.unobserve(item.target);
    try { item.target.src = await blobUrl(`/api/screenshots/${item.target.dataset.id}/${item.target.dataset.thumb === '1' ? 'thumb' : 'image'}`); } catch { item.target.alt = 'Image unavailable'; }
  }), { rootMargin: '150px' });
  const viewShot = async (s, name) => {
    const img = h('img', { class: 'full', alt: `Screenshot at ${dtShort(s.takenAt)}` });
    const dlg = dialog(`${name} · ${dtShort(s.takenAt)}`, [img, h('p', { class: 'muted small' }, `${s.width} × ${s.height} px · ${s.format.toUpperCase()} · ${bytesLabel(s.bytes)}`)], { wide: true });
    dlg.querySelector('.dialog-actions').append(h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close'));
    try { img.src = await blobUrl(`/api/screenshots/${s.id}/image`); } catch (e) { dlg.fail(e); }
  };
  let loadSeq = 0; // a newer request wins: rapid date changes must not append two pages
  const load = async () => {
    const mine = ++loadSeq; clear(host);
    const t = await api('GET', `/api/timeline?userId=${encodeURIComponent(person.value)}&date=${dateInput.value}&tzOffsetMinutes=${tzOffset()}`);
    if (mine !== loadSeq) return;
    host.append(h('div', { class: 'stats' }, stat('Tracked', dur(t.totals.trackedMs)), stat('Idle (estimate)', dur(t.totals.idleMs)), stat('First start', t.totals.firstStartAt ? timeOnly(t.totals.firstStartAt) : '—'), stat('Last stop', t.totals.lastEndAt ? timeOnly(t.totals.lastEndAt) : '—'), stat('Time blocks', String(t.totals.entries)), stat('Breaks', t.totals.breaks ? `${t.totals.breaks} · ${dur(t.totals.breakMs)}` : '0'), stat('Awaiting approval', String(t.totals.pending)), stat('Screenshots', t.totals.screenshots === null ? 'hidden' : String(t.totals.screenshots))));
    host.append(h('div', { class: 'card' }, h('h2', {}, `${t.person.name} · ${dayLabel(t.dayStartAt)}`),
      t.entries.length ? [dayBar(t), h('div', { class: 'legend small muted' }, h('span', { class: 'swatch approved' }), 'Approved', h('span', { class: 'swatch pending' }), 'Waiting', h('span', { class: 'swatch rejected' }), 'Rejected', h('span', { class: 'swatch running' }), 'Running', h('span', { class: 'swatch break' }), 'Break', h('span', { class: 'tick-legend' }), 'Screenshot')] : emptyState('No tracked time on this day.', 'Pick another day with the arrows above.')));
    if (t.activity) {
      const rows = t.activity.hours.map(x => ({ label: `${String(x.hour).padStart(2, '0')}`, value: Math.round(x.activeSeconds / 6) / 10, title: `${String(x.hour).padStart(2, '0')}:00: about ${Math.round(x.activeSeconds / 60)} min with input out of ${Math.round(x.sampledSeconds / 60)} min sampled (${x.keyDownCount} key-downs, ${x.mouseClickCount} clicks)` }));
      host.append(h('div', { class: 'card' }, h('h2', {}, 'Estimated minutes with keyboard or mouse input, per hour'), barChart(rows, { label: 'Estimated minutes with input per hour', format: v => `${Math.round(v)}m` }), h('p', { class: 'muted small' }, t.activity.note)));
    }
    if (t.screenshotsHidden) host.append(h('div', { class: 'banner info' }, 'This person\'s screenshots are visible to them only (organization policy).'));
    else if (t.screenshots.length) {
      const grid = h('div', { class: 'strip' });
      for (const s of t.screenshots) { const img = h('img', { class: 'img', alt: `Screenshot at ${dtShort(s.takenAt)}`, 'data-id': s.id, 'data-thumb': s.hasThumb ? '1' : '0' }); grid.append(h('button', { class: 'shot', type: 'button', onclick: () => viewShot(s, t.person.name) }, img, h('div', { class: 'cap' }, timeOnly(s.takenAt)))); imgObserver.observe(img); }
      host.append(h('div', { class: 'card' }, h('h2', {}, `Screenshots (${t.screenshots.length})`), h('p', { class: 'muted small' }, 'Viewing someone else\'s screenshot is recorded in the audit log.'), grid));
    }
    if (t.breaks && t.breaks.length) host.append(h('div', { class: 'card' }, h('h2', {}, 'Breaks'), h('p', { class: 'muted small' }, 'Pauses the person chose as a break in the desktop app. Break time is not counted as tracked time.'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['From', 'To', 'Length'].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x)))), h('tbody', {}, t.breaks.map(b => h('tr', {}, h('td', {}, timeOnly(b.startAt)), h('td', {}, b.endAt ? timeOnly(b.endAt) : badge('still going', 'info')), h('td', { class: 'num' }, dur((b.endAt ? Date.parse(b.endAt) : Date.now()) - Date.parse(b.startAt))))))))));
    if (t.entries.length) host.append(h('div', { class: 'card' }, h('h2', {}, 'Time blocks'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['From', 'To', 'Project / task', 'Tracked', 'Idle (est.)', 'Status'].map((x, i) => h('th', { class: i === 3 || i === 4 ? 'num' : '' }, x)))),
      h('tbody', {}, t.entries.map(e => h('tr', {}, h('td', {}, timeOnly(e.startAt)), h('td', {}, e.endAt ? timeOnly(e.endAt) : 'running'), h('td', { class: 'wrap' }, [e.projectName, e.taskLabel].filter(Boolean).join(' · ') || '—'), h('td', { class: 'num' }, dur(e.trackedMs)), h('td', { class: 'num muted' }, dur(e.idleMs)), h('td', {}, e.running ? badge('running', 'info') : statusBadge(e.status)))))))));
  };
  const go1 = () => load().catch(e => showError(main, e));
  const step = n => () => { dateInput.value = addDays(dateInput.value, n); go1(); };
  main.append(pageHead('Day view', 'One person, one day: when they tracked, what was captured and the count-only activity estimate.',
    users.length > 1 ? h('label', {}, 'Person', person) : null, h('button', { class: 'btn', type: 'button', id: 'day-prev', onclick: step(-1) }, '← Previous'), h('label', {}, 'Day', dateInput), h('button', { class: 'btn', type: 'button', id: 'day-next', onclick: step(1) }, 'Next →'), h('button', { class: 'btn', type: 'button', onclick: () => { dateInput.value = dateInputValue(new Date()); go1(); } }, 'Today'), h('button', { class: 'btn primary', type: 'button', onclick: go1 }, 'Show')), host);
  person.addEventListener('change', go1); dateInput.addEventListener('change', go1);
  await load();
};

// ---------- team ----------
VIEWS.team = async main => {
  const days = select([['7', 'Last 7 days'], ['14', 'Last 14 days'], ['31', 'Last 31 days']], '7');
  const sort = select([['name', 'Sort by name'], ['hours', 'Most tracked time'], ['pending', 'Most approvals waiting']], 'name');
  const host = h('div', {}); let data = null;
  const spark = person => {
    const max = Math.max(1, ...person.daily.map(d => d.trackedMs)), w = 120, hh = 26, bw = w / person.daily.length;
    const chart = svg('svg', { viewBox: `0 0 ${w} ${hh}`, class: 'spark', role: 'img', 'aria-label': `${person.name}: ${person.daily.map(d => dur(d.trackedMs)).join(', ')}` });
    person.daily.forEach((d, i) => chart.append(svg('rect', { x: i * bw + 1, y: hh - Math.max(d.trackedMs > 0 ? 2 : 0, hh * d.trackedMs / max), width: Math.max(2, bw - 2), height: Math.max(d.trackedMs > 0 ? 2 : 0, hh * d.trackedMs / max), rx: 1.5, class: 'bar-fill-svg' }, svg('title', {}, document.createTextNode(`${shortDay(d.date)}: ${dur(d.trackedMs)}`)))));
    return chart;
  };
  const render = () => {
    clear(host); if (!data) return;
    const people = [...data.people].sort((a, b) => sort.value === 'hours' ? b.trackedMs - a.trackedMs : sort.value === 'pending' ? b.pendingApprovals - a.pendingApprovals : a.name.localeCompare(b.name));
    host.append(h('div', { class: 'stats' }, stat('People', String(people.length)), stat('Tracking now', String(data.totals.tracking)), stat(`Tracked, last ${data.days} days`, dur(data.totals.trackedMs)), stat('Approvals waiting', String(data.totals.pending))));
    host.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Status', `Per day (${data.days} d)`, 'Tracked', 'Breaks', 'Idle (est.)', 'Days tracked', 'Approvals', 'Screenshots', ''].map((x, i) => h('th', { class: i >= 3 && i <= 8 ? 'num' : '' }, x)))),
      h('tbody', {}, people.map(p => h('tr', {}, h('td', {}, h('strong', {}, p.name), p.team ? h('span', { class: 'muted small' }, ` · ${p.team}`) : null), h('td', {}, h('span', { class: `dot ${p.state}` }), p.state === 'tracking' ? 'Tracking' : p.state === 'paused' ? 'Paused' : 'Offline'), h('td', {}, spark(p)),
        h('td', { class: 'num' }, dur(p.trackedMs)), h('td', { class: 'num' }, p.breaks ? `${p.breaks} · ${dur(p.breakMs)}` : '—'), h('td', { class: 'num muted' }, p.trackedMs ? `${Math.round(p.idleMs / p.trackedMs * 100)}%` : '—'), h('td', { class: 'num' }, `${p.activeDays}/${data.days}`), h('td', { class: 'num' }, p.pendingApprovals ? badge(String(p.pendingApprovals), 'warn') : '0'), h('td', { class: 'num' }, p.screenshots === null ? h('span', { class: 'muted', title: 'Visible to the person only (policy)' }, 'hidden') : p.screenshots),
        h('td', { class: 'actions-cell' }, h('button', { class: 'btn small', type: 'button', onclick: () => { timelineTarget = { userId: p.userId, date: dateInputValue(new Date()) }; go('timeline', true); } }, 'Day view'))))))),
      h('p', { class: 'muted small' }, data.note)));
  };
  const load = async () => { data = await api('GET', `/api/team/summary?days=${days.value}&tzOffsetMinutes=${tzOffset()}`); render(); };
  main.append(pageHead('Team', 'Tracked time, status and approvals for the people you can see. Facts only: no scores or rankings of work quality.', h('label', {}, 'Period', days), h('label', {}, 'Order', sort), h('button', { class: 'btn primary', type: 'button', onclick: () => load().catch(e => showError(main, e)) }, 'Refresh')), host);
  days.addEventListener('change', () => load().catch(e => showError(main, e))); sort.addEventListener('change', render);
  await load(); registerTimer(setInterval(() => load().catch(() => {}), 30000));
};

// ---------- integrations (API keys) ----------
VIEWS.integrations = async main => {
  const host = h('div', {});
  const SCOPE_LABELS = { 'users:read': 'People (name, email, role, manager, team)', 'projects:read': 'Projects and tasks', 'time:read': 'Time entries (hours only)' };
  const load = async () => {
    clear(host); const { keys, scopes } = await api('GET', '/api/admin/api-keys');
    const active = keys.filter(k => !k.revokedAt);
    host.append(h('div', { class: 'card' }, h('h2', {}, 'API keys'),
      h('p', { class: 'muted small' }, 'Keys let another system read people, projects and approved hours through a read-only API. Keys never expose screenshots, activity counts, breaks or pay. Each key is shown once; only a hash is stored. Revoke a key to stop it immediately.'),
      active.length || keys.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Key', 'Access', 'Created', 'Last used', 'Status', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, keys.map(k => h('tr', {}, h('td', {}, h('strong', {}, k.name)), h('td', {}, h('code', {}, `${k.prefix}…`)), h('td', { class: 'wrap' }, k.scopes.join(', ')), h('td', {}, `${dtShort(k.createdAt)}${k.createdBy ? ` · ${k.createdBy}` : ''}`), h('td', { class: 'muted' }, k.lastUsedAt ? dtShort(k.lastUsedAt) : 'Never'), h('td', {}, k.revokedAt ? badge('revoked', 'bad') : badge('active', 'ok')),
          h('td', { class: 'actions-cell' }, k.revokedAt ? null : h('button', { class: 'btn small danger', type: 'button', onclick: () => revoke(k) }, 'Revoke'))))))) : emptyState('No API keys yet.', 'Create one for a payroll, HR or reporting system.'),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => createDialog(scopes) }, 'Create API key'))));
    host.append(h('div', { class: 'card' }, h('h2', {}, 'Using the API'),
      h('p', { class: 'muted small' }, 'Send the key as a bearer token. Read-only; 300 requests per 5 minutes per key. Times are UTC.'),
      h('pre', { class: 'code' }, `curl -H "Authorization: Bearer <your key>" ${location.origin}/api/v1/time-entries?status=approved&limit=200`),
      h('dl', { class: 'facts' }, ...[['GET /api/v1/me', 'Check the key and its access'], ['GET /api/v1/users', 'Active people (users:read)'], ['GET /api/v1/projects', 'Projects and their tasks (projects:read)'], ['GET /api/v1/time-entries', 'Finished entries; filters from, to, userId, status (approved by default), limit, after for the next page (time:read)']].flatMap(([k, v]) => [h('dt', {}, h('code', {}, k)), h('dd', {}, v)])),
      h('p', { class: 'muted small' }, 'To be pushed changes instead of asking for them, use Webhooks below.')));
  };
  const createDialog = scopes => {
    const name = h('input', { type: 'text', maxlength: '80', required: true, placeholder: 'e.g. Payroll sync' });
    const boxes = scopes.map(s => h('input', { type: 'checkbox', value: s, checked: s !== 'users:read' ? s === 'time:read' : false, id: `scope-${s}` }));
    const dlg = dialog('Create API key', [field('Name', name), h('p', { class: 'small' }, h('strong', {}, 'Access')), ...scopes.map((s, i) => h('label', { class: 'check' }, boxes[i], SCOPE_LABELS[s] || s))]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { const chosen = boxes.filter(b => b.checked).map(b => b.value); const r = await api('POST', '/api/admin/api-keys', { name: name.value, scopes: chosen }); dlg.close(); showKey(r.key, r.note); await load(); } catch (e) { dlg.fail(e); }
    } }, 'Create key'));
  };
  const showKey = (key, note) => {
    const box = h('input', { type: 'text', readonly: true, value: key, id: 'new-api-key', 'aria-label': 'New API key' });
    const dlg = dialog('Your new API key', [h('p', { class: 'banner warn' }, note), box, h('p', { class: 'muted small' }, 'Store it in the other system\'s secret settings, never in code or chat.')]);
    dlg.querySelector('.dialog-actions').append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(key); toast('Key copied.'); } catch { box.select(); toast('Select the key and copy it.', 'warn'); } } }, 'Copy'), h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, 'I have saved it'));
    box.addEventListener('focus', () => box.select());
  };
  const revoke = k => {
    const dlg = dialog(`Revoke "${k.name}"?`, [h('p', {}, 'Any system using this key stops working immediately. This cannot be undone.')]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { await api('DELETE', `/api/admin/api-keys/${k.id}`); dlg.close(); toast('Key revoked.'); await load(); } catch (e) { dlg.fail(e); } } }, 'Revoke key'));
  };
  // ---- webhooks ----
  const hooksHost = h('div', {});
  const loadHooks = async () => {
    clear(hooksHost); const { webhooks, events } = await api('GET', '/api/admin/webhooks');
    hooksHost.append(h('div', { class: 'card', id: 'webhook-card' }, h('h2', {}, 'Webhooks'),
      h('p', { class: 'muted small' }, 'A webhook sends a signed message to another system when something happens (for example when time is approved). Messages carry ids, times and statuses only, never names, emails, screenshots, activity or pay. Targets must be public https addresses.'),
      webhooks.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Address', 'Events', 'Status', 'Last delivery', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, webhooks.map(w => h('tr', {}, h('td', {}, h('strong', {}, w.name)), h('td', { class: 'truncate', title: w.url }, (() => { try { const u = new URL(w.url); return `${u.host}${u.pathname}`; } catch { return w.url; } })()), h('td', { class: 'wrap' }, w.events.join(', ')),
          h('td', {}, w.active ? badge('on', 'ok') : badge('off', 'bad'), w.disabledReason ? h('div', { class: 'muted small' }, w.disabledReason) : null),
          h('td', {}, w.last ? [badge(w.last.status, w.last.status === 'delivered' ? 'ok' : w.last.status === 'failed' ? 'bad' : 'warn'), h('div', { class: 'muted small' }, `${dtShort(w.last.at)}${w.last.error ? ` · ${w.last.error}` : ''}`)] : h('span', { class: 'muted' }, 'None yet'), w.pending ? h('div', { class: 'muted small' }, `${w.pending} waiting to retry`) : null),
          h('td', { class: 'actions-cell' }, h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', disabled: !w.active, onclick: () => sendTest(w) }, 'Send test'), rowMenu([{ label: 'Deliveries', onclick: () => showDeliveries(w) }, { label: w.active ? 'Turn off' : 'Turn on', onclick: () => toggle(w) }, { label: 'New signing secret', onclick: () => rotate(w) }, { label: 'Delete', danger: true, onclick: () => remove(w) }])))))))) : emptyState('No webhooks yet.', 'Add one to be told when time is approved, rejected, submitted or edited.'),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => createHook(events) }, 'Add webhook')),
      h('details', {}, h('summary', { class: 'small' }, 'How to verify a message'), h('pre', { class: 'code' }, 'X-UFS-Signature: sha256=HMAC_SHA256(secret, X-UFS-Timestamp + "." + raw request body)\nReject messages whose timestamp is more than 5 minutes old.\nAnswer with any 2xx within 10 seconds. Failed deliveries retry after 1 min, 5 min, 30 min, 2 h and 12 h; a hook that keeps failing is switched off.'))));
  };
  const createHook = events => {
    const name = h('input', { type: 'text', maxlength: '80', required: true, placeholder: 'e.g. Payroll system' }); const url = h('input', { type: 'text', maxlength: '500', required: true, placeholder: 'https://example.com/hooks/ufs', autocomplete: 'off' });
    const boxes = events.map(e => h('input', { type: 'checkbox', value: e, checked: e === 'time.approved' }));
    const dlg = dialog('Add webhook', [field('Name', name), field('Address (https, public host)', url), h('p', { class: 'small' }, h('strong', {}, 'Send me')), ...events.map((e, i) => h('label', { class: 'check' }, boxes[i], e))]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { const r = await api('POST', '/api/admin/webhooks', { name: name.value, url: url.value, events: boxes.filter(b => b.checked).map(b => b.value) }); dlg.close(); showSecret(r.secret, r.note); await loadHooks(); } catch (e) { dlg.fail(e); }
    } }, 'Add webhook'));
  };
  const showSecret = (secret, note) => {
    const box = h('input', { type: 'text', readonly: true, value: secret, id: 'new-webhook-secret', 'aria-label': 'Signing secret' });
    const dlg = dialog('Signing secret', [h('p', { class: 'banner warn' }, note), box, h('p', { class: 'muted small' }, 'The other system uses it to check that a message really came from here.')]);
    dlg.querySelector('.dialog-actions').append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(secret); toast('Secret copied.'); } catch { box.select(); toast('Select the secret and copy it.', 'warn'); } } }, 'Copy'), h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, 'I have saved it'));
    box.addEventListener('focus', () => box.select());
  };
  const sendTest = async w => { try { const r = await api('POST', `/api/admin/webhooks/${w.id}/test`); toast(r.webhook.last?.status === 'delivered' ? 'Test delivered.' : `Test not delivered: ${r.webhook.last?.error || 'no answer'}`, r.webhook.last?.status === 'delivered' ? 'ok' : 'warn'); await loadHooks(); } catch (e) { showError(main, e); } };
  const toggle = async w => { try { await api('PATCH', `/api/admin/webhooks/${w.id}`, { active: !w.active }); toast(w.active ? 'Webhook turned off.' : 'Webhook turned on.'); await loadHooks(); } catch (e) { showError(main, e); } };
  const rotate = w => {
    const dlg = dialog(`New signing secret for "${w.name}"?`, [h('p', {}, 'The old secret stops working immediately. Update the other system right after copying the new one.')]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { const r = await api('POST', `/api/admin/webhooks/${w.id}/rotate-secret`); dlg.close(); showSecret(r.secret, r.note); } catch (e) { dlg.fail(e); } } }, 'Create new secret'));
  };
  const remove = w => {
    const dlg = dialog(`Delete "${w.name}"?`, [h('p', {}, 'Its delivery history is deleted with it. This cannot be undone.')]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { await api('DELETE', `/api/admin/webhooks/${w.id}`); dlg.close(); toast('Webhook deleted.'); await loadHooks(); } catch (e) { dlg.fail(e); } } }, 'Delete webhook'));
  };
  const showDeliveries = async w => {
    const body = h('div', {}); const dlg = dialog(`Deliveries to "${w.name}"`, [body], { wide: true });
    dlg.querySelector('.dialog-actions').append(h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close'));
    try {
      const { deliveries } = await api('GET', `/api/admin/webhooks/${w.id}/deliveries`);
      body.append(deliveries.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Event', 'Result', 'Attempts', 'Detail'].map(t => h('th', {}, t)))), h('tbody', {}, deliveries.map(d => h('tr', {}, h('td', {}, dtShort(d.createdAt)), h('td', {}, d.event), h('td', {}, badge(d.status, d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn')), h('td', { class: 'num' }, d.attempts), h('td', { class: 'wrap muted small' }, d.error || (d.httpStatus ? `HTTP ${d.httpStatus}` : d.nextAttemptAt ? `Next try ${dtShort(d.nextAttemptAt)}` : ''))))))) : emptyState('No deliveries yet.'));
    } catch (e) { dlg.fail(e); }
  };
  main.append(pageHead('Integrations', 'Connect other systems: read people, projects and approved hours, or be told when time changes.'), host, hooksHost);
  await load(); await loadHooks();
};

// ---------- reports ----------
VIEWS.reports = async main => {
  const { users, options } = await userOptions(); const range = rangeControls(7);
  const reportType = select([['hours', 'Hours worked'], ['activity', 'Activity estimate'], ['activity-daily', 'Daily activity rollup (UTC)'], ['attendance', 'Schedule and tracked-time evidence']], 'hours');
  const groupBy = select([['user', 'By person'], ['project', 'By project'], ['day', 'By day']], seesOthers() ? 'user' : 'day'); const person = select(options, '');
  const host = h('div', {});
  const qs = () => { const dateOnly = ['attendance','activity-daily'].includes(reportType.value); const { from, to } = dateOnly ? {from:range.fromInput.value,to:range.toInput.value} : range.get(); const q = new URLSearchParams({ from, to, groupBy: groupBy.value, tzOffsetMinutes: String(tzOffset()) }); if (person.value) q.set('userId', person.value); return q; };
  const load = async () => {
    clear(host);
    const activity = reportType.value === 'activity';
    const attendance = reportType.value === 'attendance';
    const dailyActivity=reportType.value==='activity-daily';
    const data = await api('GET', `/api/reports/${dailyActivity?'activity/daily':attendance ? 'attendance' : activity ? 'activity' : 'hours'}?${qs()}`);
    if (dailyActivity) {
      if (!data.groups.length) host.append(h('div',{class:'card'},emptyState('No daily activity aggregates in this range. Activity counting is optional and off by default.')));
      else {
        host.append(h('div',{class:'stats'},stat('Active seconds',data.total.activeSeconds),stat('Sampled seconds',data.total.sampledSeconds),stat('Activity estimate',data.total.activityPercent===null?'No samples':`${data.total.activityPercent}%`)));
        const headings=['UTC date','Group','Activity estimate','Active seconds','Sampled seconds','Key-downs','Clicks','Entries'];
        const rows=data.groups.map(row=>h('tr',{},h('td',{},row.date),h('td',{},row.label),h('td',{class:'num'},row.activityPercent===null?'No samples':`${row.activityPercent}%`),h('td',{class:'num'},row.activeSeconds),h('td',{class:'num'},row.sampledSeconds),h('td',{class:'num'},row.keyboardCount),h('td',{class:'num'},row.mouseCount),h('td',{class:'num'},row.entries)));
        const table=h('table',{},h('thead',{},h('tr',{},headings.map((label,index)=>h('th',{class:index>1?'num':''},label)))),h('tbody',{},rows));
        host.append(h('div',{class:'card'},h('div',{class:'table-wrap'},table)));
      }
      host.append(h('p',{class:'muted small'},data.note));return;
    }
    if (attendance) {
      if (!data.rows.length) host.append(h('div',{class:'card'},emptyState('No scheduled workdays in this range. Enable a schedule in Policy to show tracker evidence.')));
      else {
        const totals=data.rows.reduce((t,row)=>({tracked:t.tracked+row.trackedMs,inside:t.inside+row.trackedWithinScheduleMs,outside:t.outside+row.trackedOutsideScheduleEstimateMs}),{tracked:0,inside:0,outside:0});
        host.append(h('div',{class:'stats'},stat('Scheduled days',data.rows.length),stat('Tracked',dur(totals.tracked)),stat('Within schedule (estimate)',dur(totals.inside)),stat('Outside schedule (estimate)',dur(totals.outside))));
        const headings=['Person','Date','Evidence','Timezone','Schedule','First tracked','Tracked','Within schedule','Outside schedule estimate'];
        const rows=data.rows.map(row=>h('tr',{},h('td',{},row.name),h('td',{},row.date),h('td',{},row.status.replaceAll('_',' ')),h('td',{},row.timeZone),h('td',{},`${row.scheduledStart}–${row.scheduledEnd}`),h('td',{},row.firstTrackedAt?dtShort(row.firstTrackedAt):'—'),h('td',{class:'num'},dur(row.trackedMs)),h('td',{class:'num'},dur(row.trackedWithinScheduleMs)),h('td',{class:'num'},dur(row.trackedOutsideScheduleEstimateMs))));
        const table=h('table',{},h('thead',{},h('tr',{},headings.map((label,i)=>h('th',{class:i>5?'num':''},label)))),h('tbody',{},rows));
        host.append(h('div',{class:'card'},h('div',{class:'table-wrap'},table)));
      }
      host.append(h('p',{class:'muted small'},data.note)); return;
    }
    if (!data.groups.length) { host.append(h('div', { class: 'card' }, emptyState(activity ? 'No opted-in activity estimates in this range.' : 'No time in this range.')), h('p', {class:'muted small'}, data.note)); return; }
    if (activity) {
      host.append(h('div', {class:'stats'}, stat('Activity estimate', data.total.activityPercent === null ? 'No samples' : `${data.total.activityPercent}%`),
        stat('Tracked', dur(data.total.trackedMs)), stat('Active seconds', data.total.activeSeconds), stat('Sampled seconds', data.total.sampledSeconds)));
      const headings = ['Group','Activity estimate','Active seconds','Sampled seconds','Key-downs','Clicks','Tracked'];
      const rows = data.groups.map(group => h('tr',{},h('td',{},group.label),h('td',{class:'num'},group.activityPercent === null ? 'No samples' : `${group.activityPercent}%`),
        h('td',{class:'num'},group.activeSeconds),h('td',{class:'num'},group.sampledSeconds),h('td',{class:'num'},group.keyboardCount),h('td',{class:'num'},group.mouseCount),h('td',{class:'num'},dur(group.trackedMs))));
      const table = h('table',{},h('thead',{},h('tr',{},headings.map((label,index)=>h('th',{class:index?'num':''},label)))),h('tbody',{},rows));
      host.append(h('div',{class:'card'},h('div',{class:'table-wrap'},table)));
      host.append(h('p',{class:'muted small'},data.note)); return;
    }
    const max = Math.max(...data.groups.map(g => g.trackedMs), 1);
    host.append(h('div', { class: 'stats' }, stat('Tracked', dur(data.total.trackedMs)), stat('Approved', dur(data.total.approvedMs)), stat('Pending', dur(data.total.pendingMs)), stat('Entries', data.total.entries)));
    const bars = h('div', { class: 'bars' }, data.groups.map(g => { const fill = h('div', { class: 'bar-fill' }); fill.style.width = `${Math.max(2, Math.round(g.trackedMs / max * 100))}%`; return h('div', { class: 'bar-row' }, h('span', {}, g.label), h('div', { class: 'bar-track' }, fill), h('strong', { class: 'num' }, dur(g.trackedMs))); }));
    host.append(h('div', { class: 'card' }, bars));
    host.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Group', 'Tracked', 'Idle (estimate)', 'Approved', 'Pending', 'Entries'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, data.groups.map(g => h('tr', {}, h('td', {}, g.label), h('td', { class: 'num' }, dur(g.trackedMs)), h('td', { class: 'num muted' }, dur(g.idleMs)), h('td', { class: 'num' }, dur(g.approvedMs)), h('td', { class: 'num' }, dur(g.pendingMs)), h('td', { class: 'num' }, g.entries))))))));
    host.append(h('p', { class: 'muted small' }, data.note));
  };
  main.append(pageHead('Reports', 'Hours worked, opt-in activity estimates, daily UTC aggregates, or schedule and tracked-time evidence.', h('label', {}, 'Report', reportType), ...range.nodes, h('label', {}, 'Group', groupBy), users.length > 1 ? h('label', {}, 'Person', person) : null,
    h('button', { class: 'btn primary', type: 'button', onclick: () => load().catch(e => showError(main, e)) }, 'Run report'),
    h('button', { class: 'btn', type: 'button', onclick: () => { const q = qs(); q.set('format', 'csv'); const kind = reportType.value; const path=kind==='activity-daily'?'activity/daily':kind; download(`/api/reports/${path}?${q}`, `${kind}${kind==='attendance'?'':'-by-'+groupBy.value}.csv`).catch(e => showError(main, e)); } }, 'Export CSV')), host);
  await load();
};

// ---------- projects ----------
VIEWS.projects = async main => {
  const { teams } = await api('GET', '/api/teams'); const host = h('div', {});
  const load = async () => {
    clear(host); const { projects } = await api('GET', '/api/projects');
    if (!projects.length) { host.append(h('div', { class: 'card' }, emptyState('No projects yet. Add one to let people pick it in the desktop tracker.'))); return; }
    for (const p of projects) host.append(h('div', { class: 'card' },
      h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, p.name, ' ', p.active ? null : badge('inactive', 'warn')), h('p', { class: 'muted small' }, [p.client, p.teamId ? `Team: ${teams.find(t => t.id === p.teamId)?.name ?? '?'}` : 'All teams'].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => taskDialog(p) }, 'Add task'), h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('PATCH', `/api/projects/${p.id}`, { active: !p.active }); await load(); } catch (e) { showError(main, e); } } }, p.active ? 'Deactivate' : 'Activate'))),
      p.tasks.length ? h('div', { class: 'actions' }, p.tasks.map(t => h('button', { class: 'btn small', type: 'button', title: t.active ? 'Click to deactivate' : 'Click to activate', onclick: async () => { try { await api('PATCH', `/api/tasks/${t.id}`, { active: !t.active }); await load(); } catch (e) { showError(main, e); } } }, t.name, t.active ? '' : ' (inactive)'))) : h('p', { class: 'muted small' }, 'No tasks.')));
  };
  const projectDialog = () => {
    const name = h('input', { type: 'text', maxlength: '120', required: true }); const client = h('input', { type: 'text', maxlength: '120' }); const team = select([['', 'All teams'], ...teams.map(t => [t.id, t.name])], '');
    const dlg = dialog('New project', [field('Name', name), field('Client (optional)', client), field('Visible to', team)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', '/api/projects', { name: name.value, client: client.value || null, teamId: team.value || null }); dlg.close(); await load(); } catch (e) { dlg.fail(e); } } }, 'Create'));
  };
  const taskDialog = p => {
    const name = h('input', { type: 'text', maxlength: '120', required: true });
    const dlg = dialog(`New task in ${p.name}`, [field('Task name', name)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', `/api/projects/${p.id}/tasks`, { name: name.value }); dlg.close(); await load(); } catch (e) { dlg.fail(e); } } }, 'Add'));
  };
  main.append(pageHead('Projects & tasks', 'These appear in the desktop tracker\'s project picker.', h('button', { class: 'btn primary', type: 'button', onclick: projectDialog }, 'New project')), host);
  await load();
};

// ---------- people ----------
VIEWS.people = async main => {
  const host = h('div', {});
  const syncResult = (report, owner) => report.status === 'ok' ? banner('ok', report.message) : report.status === 'blocked' ? banner('warn', `Not applied: ${report.message}${owner ? ' You can review and force it below.' : ''}`) : banner('error', report.message || 'The directory sync failed.');
  const runSync = async force => {
    try { const res = await fetch('/api/directory/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(force ? { force: true } : {}) }); const data = await res.json().catch(() => ({})); if (res.status === 401) { signOutLocal(); return; } if (!res.ok && !data.status) throw new Error(data.error || 'The directory sync failed.'); await load(); host.prepend(syncResult(data, me.user.role === 'owner')); }
    catch (e) { showError(main, e); }
  };
  const directoryCard = (s, log) => {
    if (!s.enabled) return h('div', { class: 'card' }, h('h2', {}, 'UFS People directory'), h('p', { class: 'muted small' }, 'Not connected. People are managed here in the tracker. To sync from UFS People, the server needs DIRECTORY_URL and DIRECTORY_TOKEN (see the server README).'));
    const last = s.lastSync; const kind = !last ? 'Never synced' : last.status === 'ok' ? 'Synced' : last.status === 'blocked' ? 'Blocked' : 'Failed';
    const blockedNow = last && last.status === 'blocked';
    return h('div', { class: 'card' },
      h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, 'UFS People directory ', badge(kind, !last ? '' : last.status === 'ok' ? 'ok' : last.status === 'blocked' ? 'warn' : 'bad')), h('p', { class: 'muted small' }, `${s.host} · every ${s.intervalMinutes} min · ${s.counts.activeUsers} active and ${s.counts.inactiveUsers} inactive people · ${s.counts.identities} sign-in identities${s.lastSuccessAt ? ` · last success ${dtShort(s.lastSuccessAt)}` : ''}`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', id: 'directory-sync', onclick: () => runSync(false) }, 'Sync now'), blockedNow && me.user.role === 'owner' ? h('button', { class: 'btn danger', type: 'button', onclick: () => { if (confirm(`${last.message}\n\nApply this sync anyway? People it removes will be signed out and deactivated. This is recorded in the audit log.`)) runSync(true); } }, 'Review and force…') : null)),
      last ? h('p', { class: last.status === 'ok' ? 'muted small' : 'small' }, `${dtShort(last.at)} (${last.trigger}): ${last.message ?? ''}`) : null,
      last && last.warnings.length ? h('details', {}, h('summary', { class: 'small' }, `${last.warnings.length} warning(s) from the last sync`), h('ul', { class: 'small' }, last.warnings.slice(0, 20).map(w => h('li', {}, w)))) : null,
      log.length > 1 ? h('details', {}, h('summary', { class: 'small muted' }, 'Recent syncs'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Trigger', 'Result', 'Added', 'Updated', 'Deactivated'].map(t => h('th', {}, t)))), h('tbody', {}, log.map(x => h('tr', {}, h('td', {}, dtShort(x.at)), h('td', {}, x.trigger), h('td', {}, badge(x.status, x.status === 'ok' ? 'ok' : x.status === 'blocked' ? 'warn' : 'bad')), h('td', {}, x.added), h('td', {}, x.updated), h('td', {}, x.deactivated))))))) : null);
  };
  const load = async () => {
    clear(host);
    const [{ users }, { teams }, dirStatus, dirLog] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/teams'), api('GET', '/api/directory/status'), api('GET', '/api/directory/log?limit=5')]);
    const byId = Object.fromEntries(users.map(u => [u.id, u])); const teamName = id => teams.find(t => t.id === id)?.name ?? '—';
    host.append(directoryCard(dirStatus, dirLog.entries));
    host.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'people-table' }, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Manager', 'Team', 'Status', 'Source', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, users.map(u => h('tr', {}, h('td', {}, u.name), h('td', { class: 'truncate', title: u.email }, u.email), h('td', {}, badge(u.role, u.role === 'employee' ? '' : 'info')), h('td', {}, u.managerId ? byId[u.managerId]?.name ?? '—' : '—'), h('td', {}, teamName(u.teamId)),
        h('td', {}, u.active ? (u.mustChangePassword ? badge('invited', 'warn') : badge('active', 'ok')) : badge('inactive', 'bad')),
        h('td', {}, u.source === 'directory' ? badge('UFS People', 'info') : badge('local')),
        h('td', { class: 'actions-cell' }, h('div', { class: 'actions' }, u.source === 'directory' ? h('button', { class: 'btn small', type: 'button', disabled: true, title: 'Name, role, manager, team and status are managed in UFS People' }, 'Managed in UFS People') : h('button', { class: 'btn small', type: 'button', onclick: () => userDialog(u, users, teams) }, 'Edit'),
          rowMenu([...(u.source === 'directory' ? [] : [{ label: 'Reset password', onclick: () => resetDialog(u) }]), { label: 'Sign out everywhere', onclick: async () => { try { const r = await api('POST', `/api/users/${u.id}/revoke-sessions`); host.prepend(banner('ok', `Signed ${u.name} out of ${r.revoked} session(s).`)); } catch (e) { showError(main, e); } } }]))))))))));
    host.append(h('div', { class: 'card' }, h('h2', {}, 'Teams'), h('div', { class: 'actions' }, teams.map(t => badge(t.name, 'info')), h('button', { class: 'btn small', type: 'button', onclick: teamDialog }, 'Add team'))));
  };
  const userDialog = (u, users, teams) => {
    const editing = !!u;
    const email = h('input', { type: 'email', required: true, value: u?.email ?? '', disabled: editing }); const name = h('input', { type: 'text', maxlength: '120', required: true, value: u?.name ?? '' });
    const roleOptions = [['employee', 'Employee'], ['manager', 'Manager'], ['hr', 'HR (read-only, sees everyone)'], ['admin', 'Admin'], ...(me.user.role === 'owner' ? [['owner', 'Owner']] : [])];
    const role = select(roleOptions, u?.role ?? 'employee'); const mgr = select([['', 'No manager'], ...users.filter(x => x.active && x.id !== u?.id).map(x => [x.id, x.name])], u?.managerId ?? '');
    const team = select([['', 'No team'], ...teams.map(t => [t.id, t.name])], u?.teamId ?? ''); const pw = editing ? null : h('input', { type: 'text', autocomplete: 'off', placeholder: '10+ characters, letters and a number' }); const active = editing ? h('input', { type: 'checkbox', checked: u.active }) : null;
    const dlg = dialog(editing ? `Edit ${u.name}` : 'Add person', [field('Email', email), field('Name', name), h('div', { class: 'field-row' }, field('Role', role), field('Team', team)), field('Manager (sees this person\'s time and screenshots)', mgr), pw ? field('Temporary password', pw) : null, active ? h('label', { class: 'check' }, active, 'Active') : null]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try {
        if (editing) await api('PATCH', `/api/users/${u.id}`, { name: name.value, role: role.value, managerId: mgr.value || null, teamId: team.value || null, active: active.checked });
        else await api('POST', '/api/users', { email: email.value, name: name.value, role: role.value, managerId: mgr.value || null, teamId: team.value || null, temporaryPassword: pw.value });
        dlg.close(); await load();
      } catch (e) { dlg.fail(e); }
    } }, editing ? 'Save' : 'Create'));
  };
  const resetDialog = u => {
    const pw = h('input', { type: 'text', autocomplete: 'off', placeholder: '10+ characters, letters and a number' });
    const dlg = dialog(`Reset password for ${u.name}`, [h('p', { class: 'muted small' }, 'They will be signed out everywhere and must choose a new password at next sign-in. Share the temporary password through a secure channel.'), field('Temporary password', pw)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', `/api/users/${u.id}/reset-password`, { temporaryPassword: pw.value }); dlg.close(); host.prepend(banner('ok', `Password reset for ${u.name}.`)); } catch (e) { dlg.fail(e); } } }, 'Reset password'));
  };
  const teamDialog = () => {
    const name = h('input', { type: 'text', maxlength: '80', required: true });
    const dlg = dialog('New team', [field('Team name', name)]);
    dlg.querySelector('.dialog-actions').append(cancelButton(dlg), h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', '/api/teams', { name: name.value }); dlg.close(); await load(); } catch (e) { dlg.fail(e); } } }, 'Create'));
  };
  main.append(pageHead('People', 'Accounts, roles and who manages whom. People from UFS People are managed there and sync here.', h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { const [{ users }, { teams }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/teams')]); userDialog(null, users, teams); } catch (e) { showError(main, e); } } }, 'Add person')), host);
  await load();
};

// ---------- policy ----------
const POLICY_FIELDS = [
  ['screenshotsEnabled', 'Capture screenshots', 'bool'], ['screenshotIntervalSeconds', 'Screenshot interval (seconds, 10–3600)', 'number', 10, 3600], ['screenshotBlur', 'Blur screenshots', 'bool'],
  ['captureAllScreens', 'Capture all connected screens (joined in one image; needs a new notice version)', 'bool'],
  ['idleTimeoutSeconds', 'Idle prompt after (seconds, 60–3600)', 'number', 60, 3600], ['activityTrackingEnabled', 'Count keyboard key-downs and mouse clicks (no content)', 'bool'], ['retentionDays', 'Delete screenshots after (days, 1–365)', 'number', 1, 365],
  ['screenshotVisibility', 'Who can view screenshots', 'enum', [['employee_manager', 'Employee and direct manager'], ['employee_only', 'Employee only']]],
  ['allowEmployeeDelete', 'Employees may delete their own screenshots', 'bool'], ['requireProject', 'Require choosing a project', 'bool'], ['consentVersion', 'Monitoring notice version (raise to re-ask consent)', 'number', 1, 99],
  ['imageFormat', 'Screenshot image format', 'enum', [['webp', 'WebP (about 4x smaller)'], ['png', 'PNG (lossless, larger)']]], ['imageQuality', 'WebP quality (40–95)', 'number', 40, 95],
  ['breakReminderMinutes', 'Break reminder interval in tracked minutes (0 disables)', 'number', 0, 240],
  ['workScheduleEnabled', 'Remind employees when scheduled hours are untracked', 'bool'],
  ['workDays', 'Scheduled weekdays (selected timezone)', 'days', [[0, 'Sunday'], [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday']]],
  ['workTimeZone', 'Work timezone (IANA, e.g. America/New_York)', 'text'], ['workStartLocal', 'Scheduled work start (selected timezone)', 'time'], ['workEndLocal', 'Scheduled work end (same day)', 'time'],
  ['lateGraceMinutes', 'Late threshold after scheduled start (minutes, 0–180)', 'number', 0, 180],
];
VIEWS.policy = async main => {
  const [{ teams }, { users }] = await Promise.all([api('GET', '/api/teams'), api('GET', '/api/users')]);
  const scope = select([['org:org', 'Whole organization'], ...teams.map(t => [`team:${t.id}`, `Team: ${t.name}`]), ...users.map(u => [`user:${u.id}`, `Person: ${u.name}`])], 'org:org');
  const host = h('div', { class: 'card' });
  const load = async () => {
    clear(host); const [kind, id] = scope.value.split(':'); const { overrides, effective } = await api('GET', `/api/policy/${kind}/${id}`);
    const base = (await api('GET', '/api/me')).policy; const rows = [];
    host.append(h('p', { class: 'muted small' }, kind === 'org' ? 'Defaults for everyone. Teams and people can override individual settings.' : 'Tick “override” to set a value for this scope; unticked settings inherit from the level above. Tracking is always visible to the employee; there is no hidden-tracking option.'));
    for (const [key, label, type, a, b] of POLICY_FIELDS) {
      if (key === 'captureAllScreens' && kind !== 'org') continue;
      const has = key in overrides; const value = has ? overrides[key] : (effective ?? base)[key];
      let control;
      if (type === 'bool') control = h('input', { type: 'checkbox', checked: !!value });
      else if (type === 'number') control = h('input', { type: 'number', min: String(a), max: String(b), value: String(value) });
      else if (type === 'text') control = h('input', { type: 'text', maxlength: '100', value, autocomplete: 'off' });
      else if (type === 'time') control = h('input', { type: 'time', value });
      else if (type === 'days') control = select(a, value, { multiple: true, size: 7, 'aria-label': label });
      else control = select(a, value);
      const over = kind === 'org' ? null : h('input', { type: 'checkbox', checked: has, 'aria-label': `Override ${label}` });
      const getValue = () => type === 'bool' ? control.checked : type === 'number' ? Number(control.value) : type === 'days' ? [...control.selectedOptions].map(option => Number(option.value)).sort((x, y) => x - y) : control.value;
      rows.push({ key, getValue, over });
      host.append(h('div', { class: 'field-row' }, h('label', { class: 'check' }, type === 'bool' ? control : null, label), h('div', { class: 'check' }, type === 'bool' ? null : control, over ? h('label', { class: 'check' }, over, 'override') : null)));
    }
    host.append(h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try {
        const body = {}; for (const r of rows) if (!r.over || r.over.checked) body[r.key] = r.getValue();
        await api('PUT', `/api/policy/${kind}/${id}`, body); host.prepend(banner('ok', 'Policy saved.')); setTimeout(() => load().catch(() => {}), 800);
      } catch (e) { showError(host, e); }
    } }, 'Save policy')));
  };
  scope.addEventListener('change', () => load().catch(e => showError(main, e)));
  main.append(pageHead('Policy', 'Tracking rules, break prompts, optional work schedules, screenshot visibility and retention.', h('label', {}, 'Applies to', scope)), host);
  await load();
};

// ---------- audit ----------
VIEWS.audit = async main => {
  const host = h('div', { class: 'card' }); main.append(pageHead('Audit log', 'Who viewed, changed or deleted what. Newest first.'), host);
  const { entries } = await api('GET', '/api/audit?limit=200');
  host.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Target', 'Details'].map(t => h('th', {}, t)))),
    h('tbody', {}, entries.map(e => h('tr', {}, h('td', {}, dtShort(e.at)), h('td', {}, e.actorName ?? 'system'), h('td', {}, badge(e.action, 'info')), h('td', { class: 'muted' }, [e.targetType, e.targetId ? e.targetId.slice(0, 8) : null].filter(Boolean).join(' ')), h('td', { class: 'wrap' }, e.detail ? h('pre', { class: 'detail' }, JSON.stringify(e.detail)) : null)))))));
};

// ---------- account ----------
VIEWS.account = async main => {
  main.append(pageHead('My account', `${me.user.email} · ${me.user.role}`));
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const next = h('input', { type: 'password', autocomplete: 'new-password' });
  main.append(h('div', { class: 'card' }, h('h2', {}, 'Change password'), field('Current password', cur), field('New password (10+ characters, letters and a number)', next),
    h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', '/api/auth/change-password', { currentPassword: cur.value, newPassword: next.value }); cur.value = next.value = ''; main.prepend(banner('ok', 'Password changed. Other sessions were signed out.')); } catch (e) { showError(main, e); } } }, 'Change password')));
  main.append(h('div', { class: 'card' }, h('h2', {}, 'Monitoring notice'), h('p', { class: 'muted small' }, NOTICE_VERSION_TEXT), me.needsConsent ? consentBanner() : h('p', {}, badge('Accepted', 'ok'), ' ', me.user.consentAt ? h('span', { class: 'muted small' }, `on ${dtShort(me.user.consentAt)}`) : null)));
  main.append(h('div', { class: 'card' }, h('h2', {}, 'What your organization currently records'), h('ul', {},
    h('li', {}, me.policy.screenshotsEnabled ? `A screenshot of ${me.policy.captureAllScreens ? 'all your connected screens (joined in one image)' : 'the screen you choose'} every ${Math.round(me.policy.screenshotIntervalSeconds / 60) || 1} minute(s) while tracking is visibly on${me.policy.screenshotBlur ? ' (blurred)' : ''}.` : 'No screenshots.'),
    h('li', {}, `Time tracked, and an estimate of idle time (no keyboard or mouse input). ${me.policy.activityTrackingEnabled ? 'Keyboard key-down and mouse-click counts and active seconds per minute are also enabled; no key identity, text or mouse position is stored.' : 'Keyboard and mouse counts are off.'}`), h('li', {}, `Screenshots are deleted after ${me.policy.retentionDays} days. ${me.policy.screenshotVisibility === 'employee_only' ? 'Only you can view them.' : 'You, your direct manager and HR can view them.'}`),
    h('li', {}, me.policy.breakReminderMinutes ? `The desktop may remind you to take a break after ${me.policy.breakReminderMinutes} tracked minutes. You decide whether to pause; reminders do not change your time.` : 'Break reminders are off.', me.policy.workScheduleEnabled ? ` Scheduled-hour reminders use ${me.policy.workDays.map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')} ${me.policy.workStartLocal}–${me.policy.workEndLocal} in your device local time while the app is open.` : ' Scheduled-hour reminders are off.'),
    h('li', {}, 'Not recorded: audio, camera, keystrokes, or which apps or websites you use.'))));
  const reportCard = h('div', { class: 'card', id: 'report-card' }); main.append(reportCard);
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const loadReports = async () => {
    clear(reportCard); const { subscriptions, available, emailDelivery } = await api('GET', '/api/report-subscriptions');
    const kind = select(available.map(a => [a.kind, a.title]), available[0]?.kind), weekday = select(WEEKDAYS.map((d, i) => [i, d]), 1), hour = select(Array.from({ length: 24 }, (_, i) => [i, `${String(i).padStart(2, '0')}:00`]), 8);
    const zone = h('input', { type: 'text', maxlength: '60', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', 'aria-label': 'Timezone' });
    reportCard.append(h('h2', {}, 'Weekly reports'), h('p', { class: 'muted small' }, `A summary of last week, sent once a week and limited to what you can already see in the dashboard. ${emailDelivery ? 'Sent by email and shown under the bell.' : 'Email delivery is not switched on yet, so reports arrive under the bell for now.'}`),
      subscriptions.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Report', 'When', 'Last sent', ''].map(t => h('th', {}, t)))), h('tbody', {}, subscriptions.map(s => h('tr', {}, h('td', {}, s.title), h('td', {}, `${WEEKDAYS[s.weekday]} ${String(s.hour).padStart(2, '0')}:00 (${s.timeZone})`), h('td', { class: 'muted' }, s.lastSentOn || 'Not yet'),
        h('td', { class: 'actions-cell' }, h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('POST', `/api/report-subscriptions/${s.id}/send-now`); toast('Sent. Look under the bell.'); } catch (e) { showError(main, e); } } }, 'Send now'), h('button', { class: 'btn small danger', type: 'button', onclick: async () => { try { await api('DELETE', `/api/report-subscriptions/${s.id}`); toast('Report removed.'); await loadReports(); } catch (e) { showError(main, e); } } }, 'Remove')))))))) : h('p', { class: 'muted small' }, 'You are not subscribed to any report.'),
      h('div', { class: 'field-row' }, field('Report', kind), field('Timezone (e.g. America/New_York)', zone)), h('div', { class: 'field-row' }, field('Day', weekday), field('Time', hour)),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('POST', '/api/report-subscriptions', { kind: kind.value, weekday: Number(weekday.value), hour: Number(hour.value), timeZone: zone.value.trim() }); toast('Report saved.'); await loadReports(); } catch (e) { showError(main, e); } } }, 'Save report'));
  };
  loadReports().catch(() => {});
  const notifyCard = h('div', { class: 'card' }); main.append(notifyCard);
  api('GET', '/api/notifications?limit=1').then(({ settings }) => {
    const box = h('input', { type: 'checkbox', id: 'notify-email', checked: settings.email, onchange: async () => { try { await api('PUT', '/api/me/notification-settings', { email: box.checked }); toast(box.checked ? 'Email copies turned on.' : 'Email copies turned off.'); } catch (e) { box.checked = !box.checked; showError(main, e); } } });
    notifyCard.append(h('h2', {}, 'Notifications'), h('p', { class: 'muted small' }, 'Approvals, edits and requests appear under the bell in the sidebar.'), h('label', { class: 'check' }, box, 'Also send me an email copy'),
      settings.emailDelivery ? null : h('p', { class: 'muted small' }, 'Email delivery is not switched on for this organization yet. Your choice is saved and takes effect when it is.'));
  }).catch(() => {});
  const devicesHost = h('div', { class: 'card' }); main.append(devicesHost);
  const loadDevices = async () => {
    clear(devicesHost); devicesHost.append(h('h2', {}, 'Signed-in devices'));
    const { sessions } = await api('GET', '/api/me/devices');
    devicesHost.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Device', 'Type', 'Last active', ''].map(t => h('th', {}, t)))),
      h('tbody', {}, sessions.map(s => h('tr', {}, h('td', {}, s.deviceName || 'Web browser', s.current ? h('span', {}, ' ', badge('this session', 'info')) : null), h('td', {}, s.kind), h('td', { class: 'muted' }, dtShort(s.lastSeenAt)),
        h('td', {}, s.current ? null : h('button', { class: 'btn small danger', type: 'button', onclick: async () => { try { await api('DELETE', `/api/me/devices/${s.id}`); await loadDevices(); } catch (e) { showError(main, e); } } }, 'Sign out'))))))));
  };
  await loadDevices();
};

// ---------- boot ----------
async function boot() {
  if (!token) return renderLogin();
  try { me = await api('GET', '/api/me'); } catch (e) { return renderLogin(token ? undefined : e.message); }
  if (me.user.mustChangePassword) return renderForcedPasswordChange();
  if (!NAV.some(([id, , show]) => id === current && show())) current = 'overview';
  renderShell(); await go(current);
}
boot();
