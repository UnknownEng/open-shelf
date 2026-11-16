// App shell: router, header, notifications, theme, effects bootstrap.
import { api, store, refreshMe, changed } from './api.js';
import { $, $$, esc, initials, relTime, toast, applyBrand } from './ui.js';
import { initSky, initPointerFx } from './fx.js';
import { openAuth } from './views/auth.js';
import { openBook } from './views/book.js';

// Web fonts load without blocking first paint (fallback fonts show until they arrive).
const webfonts = document.getElementById('webfonts');
if (webfonts) webfonts.media = 'all';

const app = $('#app');
const ROUTES = {
  '': () => import('./views/home.js').then((m) => m.renderHome),
  browse: () => import('./views/browse.js').then((m) => m.renderBrowse),
  shelf: () => import('./views/shelf.js').then((m) => m.renderShelf),
  admin: () => import('./views/admin.js').then((m) => m.renderAdmin),
};
let cleanup = null;
let lastPath = null;

const onAdminPath = () => /^\/admin(\/|$)/.test(location.pathname);

function parseHash() {
  // The staff console lives at its own URL: /admin or /admin/<tab>.
  if (onAdminPath()) {
    const sub = location.pathname.split('/')[2] || (location.hash.match(/^#\/admin\/(\w+)/) || [])[1];
    return { view: 'admin', sub, anchor: null, query: new URLSearchParams(location.search) };
  }
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, anchor] = raw.split('#');
  const [path, query] = pathPart.split('?');
  const [view, sub] = path.split('/');
  return { view: ROUTES[view] ? view : '', sub, anchor, query: new URLSearchParams(query || '') };
}

async function route() {
  // From /admin, any normal in-app link (#/browse, #/) leaves the console for the main site.
  if (onAdminPath() && location.hash && !location.hash.startsWith('#/admin')) { location.replace(`/${location.hash}`); return; }
  // Old-style #/admin links move to the dedicated /admin URL.
  if (!onAdminPath() && location.hash.startsWith('#/admin')) { location.replace(`/admin${location.hash.replace(/^#\/admin/, '')}`); return; }
  const { view, sub, anchor, query } = parseHash();
  const key = `${view}/${view === 'admin' ? '' : sub || ''}`;
  if (query.get('sso') === 'expired') toast('That sign-in link has expired. Please request a new one.', 'error');
  // Same page + anchor (e.g. #/#platforms): just scroll.
  if (key === lastPath && anchor) { document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }); return; }
  lastPath = key;
  cleanup?.();
  cleanup = null;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (anchor === 'platforms' ? 'platforms' : view || 'home')));
  $$('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === (view || 'home')));
  const render = await ROUTES[view]();
  app.classList.remove('view-enter');
  void app.offsetWidth;
  app.classList.add('view-enter');
  if (!anchor) window.scrollTo({ top: 0 });
  try { cleanup = (await render(app, { sub, anchor })) || null; } catch (err) {
    console.error(err);
    app.innerHTML = `<section class="wrap"><div class="empty" style="padding-top:120px"><div class="big">⚠︎</div><h3>Something went wrong</h3><p>${esc(err.message)}</p><a class="btn btn-ghost" href="#/">Go home</a></div></section>`;
  }
}

// ---------------------------------------------------------------- header
function renderHeader() {
  const me = store.me;
  $('#signInBtn').classList.toggle('hidden', !!me);
  $('#joinBtn').classList.toggle('hidden', !!me);
  $('#avatarBtn').classList.toggle('hidden', !me);
  $('#bellWrap').classList.toggle('hidden', !me);
  $('#creditPill').classList.toggle('hidden', !me);
  $('#navAdmin').classList.toggle('hidden', !store.isStaff);
  $('#tabAdmin').classList.toggle('hidden', !store.isStaff);
  if (me) {
    $('#avatarBtn').textContent = initials(me.name);
    const prev = Number($('#creditCount').textContent);
    $('#creditCount').textContent = me.credits;
    if (prev !== me.credits) { const p = $('#creditPill'); p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); }
    const badge = $('#bellBadge');
    badge.textContent = store.unread > 9 ? '9+' : store.unread;
    badge.classList.toggle('hidden', !store.unread);
  }
  if (store.tenant) {
    $('#brandName').textContent = store.tenant.name.toLowerCase();
    applyBrand(store.tenant.brandColor);
  }
}

function closePopovers(except) {
  $$('.popover.open').forEach((p) => { if (p !== except) p.classList.remove('open'); });
  $('#bellBtn').setAttribute('aria-expanded', String($('#notifPanel').classList.contains('open')));
  $('#avatarBtn').setAttribute('aria-expanded', String($('#accountMenu').classList.contains('open')));
}

async function toggleNotifications() {
  const panel = $('#notifPanel');
  const open = !panel.classList.contains('open');
  closePopovers(panel);
  panel.classList.toggle('open', open);
  closePopovers(panel);
  if (!open) return;
  panel.innerHTML = '<div class="skeleton" style="height:60px;margin:8px"></div>';
  const list = await api('/api/notifications').catch(() => []);
  const icons = { loan: '📖', return: '↩', reservation: '⏳', overdue: '⏰', welcome: '👋', credits: '◈' };
  panel.innerHTML = `<div class="pop-title">Notifications ${store.unread ? '<button id="markRead">Mark all read</button>' : ''}</div>` +
    (list.length ? list.map((n) => `<div class="notif ${n.readAt ? '' : 'unread'}"><span class="notif-ico">${icons[n.kind] || '•'}</span><div><b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ''}<small>${relTime(n.createdAt)}</small></div></div>`).join('')
      : '<p class="muted" style="padding:20px;text-align:center">You are all caught up ✨</p>');
  $('#markRead', panel)?.addEventListener('click', async () => {
    await api('/api/notifications/read', { method: 'POST', body: {} });
    store.set({ unread: 0 });
    panel.querySelectorAll('.notif.unread').forEach((n) => n.classList.remove('unread'));
    $('#markRead', panel)?.remove();
  });
}

function toggleAccountMenu() {
  const menu = $('#accountMenu');
  const open = !menu.classList.contains('open');
  closePopovers(menu);
  if (!open) { menu.classList.remove('open'); return; }
  const me = store.me;
  menu.innerHTML = `<div class="menu-head"><b>${esc(me.name)}</b><small>${esc(me.email)}</small></div>
    <a class="menu-item" href="#/shelf">📚 My shelf</a>
    <a class="menu-item" href="#/browse">🔍 Browse books</a>
    ${store.isStaff ? '<a class="menu-item" href="/admin">📊 Staff console</a>' : ''}
    <button class="menu-item" id="menuTheme">◐ Switch light / dark</button>
    <button class="menu-item" id="signOut">↪ Sign out</button>`;
  menu.classList.add('open');
  closePopovers(menu);
  $('#menuTheme', menu).onclick = () => $('#themeToggle').click();
  $('#signOut', menu).onclick = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    store.set({ me: null, unread: 0 });
    menu.classList.remove('open');
    changed();
    toast('Signed out. See you soon!');
    lastPath = null;
    route();
  };
}

// ---------------------------------------------------------------- theme
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* storage blocked */ }
  const theme = saved || 'light'; // Gen-Z cream paper look by default
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    $('meta[name=theme-color]').content = next === 'dark' ? '#111111' : '#fff4e0';
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  initTheme();
  initSky($('#sky'));
  initPointerFx();
  addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', scrollY > 10), { passive: true });

  $('#signInBtn').onclick = () => openAuth('login');
  $('#joinBtn').onclick = () => openAuth('register');
  $('#bellBtn').onclick = (e) => { e.stopPropagation(); toggleNotifications(); };
  $('#avatarBtn').onclick = (e) => { e.stopPropagation(); toggleAccountMenu(); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover')) closePopovers(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!location.hash.startsWith('#/browse')) location.hash = '#/browse';
      setTimeout(() => $('#q')?.focus(), 250);
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('book-card')) { e.preventDefault(); openBook(e.target.dataset.id); }
    if (e.key === 'Escape' && $('.popover.open')) { closePopovers(); }
  });

  store.subscribe(renderHeader);
  const [tenant] = await Promise.all([api('/api/tenant').catch(() => null), refreshMe()]);
  store.set({ tenant });
  addEventListener('auth:expired', () => { toast('Your session ended. Please sign in again.', 'error'); openAuth('login'); });
  let wasSignedIn = !!store.me;
  store.subscribe(() => {
    // Re-render the current view when auth state flips (sign in / out).
    if (!!store.me !== wasSignedIn) { wasSignedIn = !!store.me; lastPath = null; route(); }
  });
  addEventListener('hashchange', route);
  route();

  // Keep notifications/credits fresh.
  setInterval(() => { if (store.me && !document.hidden) refreshMe(); }, 45_000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
