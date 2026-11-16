// Shared rendering helpers: escaping, covers, dates, toasts, modals.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function esc(s = '') {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function safeUrl(s = '') {
  try { const u = new URL(s, location.href); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

const PALETTES = [
  ['#ff4fa3', '#7b2ff7'], ['#0a8f55', '#01411c'], ['#4d5bff', '#00a3ff'], ['#ff7a1a', '#e1264b'],
  ['#7b2ff7', '#4d5bff'], ['#0bb3a3', '#016b5f'], ['#e1264b', '#9d0f4a'], ['#121212', '#3d3d3d'],
];
const GLYPHS = ['✳', '☾', '✦', '❋', '◐', '✺', '❖', '☼'];
export function palette(key = '') {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { colors: PALETTES[h % PALETTES.length], glyph: GLYPHS[h % GLYPHS.length] };
}
export function coverVars(b) {
  const { colors } = palette(b.id || b.bookId || b.title);
  return `--c1:${colors[0]};--c2:${colors[1]}`;
}

/** Generated cover (always present) with the real cover image layered on top when it loads. */
export function cover(b, extra = '') {
  const { glyph } = palette(b.id || b.bookId || b.title);
  const src = safeUrl(b.cover);
  return `<div class="cover ${extra}" style="${coverVars(b)}">
    <div class="gen"><small>${esc((b.author || '').split(' ').slice(-1)[0])}</small>${b.altTitle ? `<span class="urdu" lang="ur">${esc(b.altTitle)}</span>` : ''}<b>${esc(b.title)}</b><i>${glyph}</i></div>
    ${src ? `<img class="cover-img" src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}
  </div>`;
}

/** 3D book (front/back/spine/pages) used by the hero and detail views. */
export function book3d(b, style = '') {
  return `<div class="book3d" style="${coverVars(b)};${style}">
    <div class="front">${cover(b)}</div><div class="back"></div><div class="spine"></div><div class="pages"></div><div class="top"></div><div class="shadow"></div>
  </div>`;
}

// Cover images: fade in on load, drop on error (CSP forbids inline handlers).
document.addEventListener('load', (e) => { if (e.target.classList?.contains('cover-img')) e.target.classList.add('loaded'); }, true);
document.addEventListener('error', (e) => { if (e.target.classList?.contains('cover-img')) e.target.remove(); }, true);

export function stars(r = 0) {
  const full = Math.round(r || 0);
  return `<span class="stars" aria-label="${r || 0} out of 5">${'★'.repeat(full)}<span class="off">${'★'.repeat(5 - full)}</span></span>`;
}

const LOCALE = 'en-PK';
const TZ = 'Asia/Karachi';
export const fmtDate = (iso) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
export const fmtShort = (iso) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: TZ });
export function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtShort(iso);
}
export const daysLeft = (iso) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export function availabilityTag(b) {
  if (b.myLoan) return '<span class="tag tag-info">On your shelf</span>';
  if (b.myReservation?.status === 'ready') return '<span class="tag tag-good">Ready for you</span>';
  if (b.myReservation) return '<span class="tag tag-info">On waitlist</span>';
  if (b.available > 0) return `<span class="tag tag-good">● ${b.available} available</span>`;
  return `<span class="tag tag-warn">Waitlist${b.queue ? ` · ${b.queue}` : ''}</span>`;
}

// ---------------------------------------------------------------- toasts
export function toast(msg, type = 'ok') {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.innerHTML = `<i>${type === 'error' ? '!' : '✓'}</i><span>${esc(msg)}</span>`;
  root.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, type === 'error' ? 5000 : 3400);
}

// ---------------------------------------------------------------- modals
let skipPop = 0;
addEventListener('popstate', () => {
  if (skipPop) { skipPop--; return; }
  const boxes = document.querySelectorAll('#modalRoot .modal');
  boxes[boxes.length - 1]?._closeFromBack?.();
});

export function modal(html, { wide = false, onClose } = {}) {
  const root = $('#modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const box = document.createElement('div');
  box.className = `modal ${wide ? 'wide' : ''}`;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = `<button class="modal-close" aria-label="Close">×</button>${html}`;
  box.tabIndex = -1;
  const labelId = `m${Math.random().toString(36).slice(2, 8)}`;
  root.append(backdrop, box);
  const labelSync = () => { const h = box.querySelector('h2'); if (h) { h.id ||= labelId; box.setAttribute('aria-labelledby', h.id); } };
  labelSync();
  new MutationObserver(labelSync).observe(box, { childList: true, subtree: true });
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => { backdrop.classList.add('open'); box.classList.add('open'); });
  document.body.style.overflow = 'hidden';
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('open');
    box.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => {
      backdrop.remove(); box.remove();
      if (!$('.modal', root)) document.body.style.overflow = '';
      prevFocus?.focus?.();
    }, 350);
    onClose?.();
    if (!poppedByBack && history.state?.osModal) { skipPop++; history.back(); }
  };
  let poppedByBack = false;
  const isTop = () => root.querySelector('.modal:last-of-type') === box;
  const onKey = (e) => {
    if (!isTop()) return; // stacked modals: only the topmost one reacts
    if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); return; }
    if (e.key === 'Tab') { // keep keyboard focus inside the dialog
      const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', close);
  box.querySelector('.modal-close').addEventListener('click', close);
  box.addEventListener('click', (e) => {
    const link = e.target.closest('[data-close-modal]');
    if (!link) return;
    e.preventDefault();
    poppedByBack = true; // don't history.back(): we replace the sheet's history entry with the destination instead
    close();
    const href = link.getAttribute('href');
    if (href) location.replace(href);
  });
  // Phone Back button closes the sheet instead of navigating the page behind it.
  history.pushState({ osModal: true }, '');
  box._closeFromBack = () => { poppedByBack = true; close(); };
  setTimeout(() => (box.querySelector('input, textarea, select') || box).focus({ preventScroll: true }), 60);
  return { el: box, close };
}

export function confirmDialog(title, body, { confirm = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal(`<h2>${esc(title)}</h2><p class="lead">${esc(body)}</p>
      <div class="detail-actions"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirm)}</button><button class="btn btn-ghost" data-no>Cancel</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    m.el.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); m.close(); };
    m.el.querySelector('[data-no]').onclick = () => m.close();
  });
}

export async function withBusy(btn, fn) {
  if (!btn) return fn();
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">…</span>';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

/** White-label: tint the whole UI with the tenant's brand colour. */
export function applyBrand(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  const n = parseInt(hex.slice(1), 16);
  const shift = (c, k) => Math.max(0, Math.min(255, Math.round(c + (255 - c) * k)));
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  // Secondary accent: warmer/brighter companion of the brand colour.
  root.setProperty('--accent-2', `rgb(${shift(r, .1)}, ${Math.round(g * .62)}, ${Math.round(b * .55)})`);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed — select and copy manually', 'error'); }
}
