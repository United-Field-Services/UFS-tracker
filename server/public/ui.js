'use strict';
// UFS Tracker dashboard: shared UI helpers and components (loaded before app.js; plain scripts, no build step).
// All text is inserted with textContent (never innerHTML); styles are applied through the CSS object model (strict CSP).
// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'style') el.style.cssText = value; // set through the CSS object model: the strict CSP blocks style attributes
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };
const pad = n => String(n).padStart(2, '0');
const dur = ms => { const m = Math.round((ms || 0) / 60000); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
const dtShort = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = iso => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayLabel = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateInputValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInputValue = iso => { const d = new Date(iso); return `${dateInputValue(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const tzOffset = () => -new Date().getTimezoneOffset();
function rangeFromInputs(fromValue, toValue) {
  const from = new Date(`${fromValue}T00:00:00`); const to = new Date(`${toValue}T00:00:00`); to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function banner(kind, text) { return h('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text); }
function showError(host, error) { host.querySelectorAll('.banner.error').forEach(b => b.remove()); host.prepend(banner('error', error.message || String(error))); }
function field(label, control) { return h('label', { class: 'field' }, h('span', {}, label), control); }
function select(options, value, attrs) { const s = h('select', attrs, options.map(([v, l]) => h('option', { value: v }, l))); if (Array.isArray(value)) for (const option of s.options) option.selected = value.includes(Number(option.value)); else if (value !== undefined && value !== null) s.value = value; return s; }
function badge(text, kind) { return h('span', { class: `badge ${kind || ''}` }, text); }
function statusBadge(status) { return badge(status, status === 'approved' ? 'ok' : status === 'rejected' ? 'bad' : 'warn'); }
function stat(label, value) { return h('div', { class: 'stat' }, h('span', {}, label), h('strong', {}, value)); }

function dialog(title, content, { wide = false, actions = [] } = {}) {
  const dlg = h('dialog', { class: wide ? 'wide' : '' });
  const errorHost = h('div', {});
  dlg.append(h('h2', {}, title), errorHost, ...[content].flat(), h('div', { class: 'dialog-actions' }, ...actions));
  dlg.addEventListener('close', () => { dlg.querySelectorAll('img.full').forEach(i => URL.revokeObjectURL(i.src)); dlg.remove(); });
  document.body.append(dlg); dlg.showModal();
  dlg.fail = error => { clear(errorHost); errorHost.append(banner('error', error.message || String(error))); };
  return dlg;
}
const cancelButton = dlg => h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel');


const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) { const el = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v)); for (const kid of kids.flat()) if (kid) el.append(kid); return el; }


// ---------- shared components (design system) ----------
// Nav and empty-state icons: 24x24 outline paths, drawn with currentColor.
const ICON_PATHS = {
  overview: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  admin: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  timesheets: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  screenshots: 'M3 5h18v14H3zM3 15l5-5 5 5 3-3 5 5M16 9h.01',
  reports: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  people: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8',
  policy: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  audit: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  empty: 'M4 7l2-3h12l2 3v12H4zM4 7h16M9 12h6',
};
function icon(name, size = 18) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'icon', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg('path', { d: ICON_PATHS[name] || ICON_PATHS.empty }));
}

/** Short message in the corner (announced to screen readers). Errors stay longer. */
function toast(message, kind = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const item = h('div', { class: `toast ${kind}` }, h('span', {}, message), h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => item.remove() }, '×'));
  host.append(item); setTimeout(() => item.remove(), kind === 'error' ? 9000 : 4500);
}

/** Loading placeholder shown while a page fetches its data. */
function skeleton(rows = 4) {
  return h('div', { class: 'skeleton-wrap', 'aria-hidden': 'true' }, h('div', { class: 'skeleton line title' }), h('div', { class: 'skeleton-cards' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton card-block' }))), Array.from({ length: rows }, () => h('div', { class: 'skeleton line' })));
}

/** "More" menu for a row's secondary actions: items = [{label, onclick, danger}]. Uses <details>, so it works with the keyboard. */
function rowMenu(items, label = 'More') {
  const list = h('div', { class: 'menu-list' }, items.map(item => h('button', { class: `menu-item${item.danger ? ' danger' : ''}`, type: 'button', onclick: event => { event.target.closest('details').open = false; item.onclick(event); } }, item.label)));
  const details = h('details', { class: 'menu' }, h('summary', { class: 'btn small', 'aria-haspopup': 'menu' }, label, ' ', h('span', { 'aria-hidden': 'true' }, '▾')), list);
  // The list is fixed-position so a scrolling table wrapper never clips it; place it under the button when it opens.
  details.addEventListener('toggle', () => { if (!details.open) return; const rect = details.querySelector('summary').getBoundingClientRect(); list.style.top = `px`; list.style.right = `px`; });
  return details;
}
document.addEventListener('click', event => { for (const open of document.querySelectorAll('details.menu[open]')) if (!open.contains(event.target)) open.open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') for (const open of document.querySelectorAll('details.menu[open]')) { open.open = false; open.querySelector('summary')?.focus(); } });

/** Copies each column header onto its cells so narrow screens can show tables as labelled cards (see style.css). */
function annotateTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) continue;
    for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((cell, i) => { if (!cell.hasAttribute('data-label')) cell.setAttribute('data-label', heads[i] ?? ''); });
  }
}
function watchTables(root) {
  let queued = false;
  const run = () => { queued = false; annotateTables(root); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(root, { childList: true, subtree: true });
  annotateTables(root);
}

/** Empty state with an icon, a title and an optional hint. */
function emptyState(text, hint) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('empty', 28)), h('p', { class: 'empty-title' }, text), hint ? h('p', { class: 'muted small' }, hint) : null);
}

window.addEventListener('scroll', () => { for (const open of document.querySelectorAll('details.menu[open]')) open.open = false; }, true);
