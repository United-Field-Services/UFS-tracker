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
  ['admin', 'Admin portal', () => isAdmin() || (me && me.user.role === 'hr')],
  ['timesheets', 'Timesheets', () => true],
  ['screenshots', 'Screenshots', () => true],
  ['reports', 'Reports', () => true],
  ['projects', 'Projects', () => isLead()],
  ['people', 'People', () => isAdmin()],
  ['policy', 'Policy', () => isAdmin()],
  ['audit', 'Audit log', () => isAdmin()],
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
      h('div', { class: 'sidebar-foot' }, h('div', { class: 'small' }, h('strong', {}, me.user.name)), h('div', { class: 'small muted' }, me.user.role), h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out'))),
    main));
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
