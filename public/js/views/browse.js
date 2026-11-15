// Catalogue: search, genre chips, availability toggle, sort, tilt cards.
import { api } from '../api.js';
import { esc, cover, stars, availabilityTag, $ } from '../ui.js';
import { reveal } from '../fx.js';
import { openBook } from './book.js';
import * as act from '../actions.js';

const state = { q: '', category: '', available: false, sort: 'popular' };

export async function renderBrowse(app) {
  app.innerHTML = `
  <section class="wrap">
    <div class="page-head">
      <div><span class="eyebrow" data-reveal>The catalogue</span><h1 data-reveal style="--i:1;margin-top:16px">Choose your <em class="grad-text">next read.</em></h1>
        <p data-reveal style="--i:2">Real paperbacks, shared by a community of readers. One credit per book.</p></div>
    </div>
    <div class="filters">
      <div class="filter-row">
        <label class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="q" placeholder="Search title, author, genre or ISBN" autocomplete="off" value="${esc(state.q)}"><kbd>Ctrl K</kbd></label>
        <select class="select" id="sort" aria-label="Sort">
          <option value="popular">Most borrowed</option><option value="rating">Top rated</option><option value="new">Newest</option><option value="title">A → Z</option><option value="available">Most available</option>
        </select>
        <label class="toggle"><input type="checkbox" id="avail" ${state.available ? 'checked' : ''}> Available now</label>
      </div>
      <div class="filter-row" style="justify-content:space-between"><div class="chips" id="chips"></div><span class="result-count" id="count"></span></div>
    </div>
    <div class="grid" id="grid">${Array.from({ length: 10 }, () => '<div><div class="skeleton" style="aspect-ratio:2/3"></div><div class="skeleton" style="height:16px;margin-top:14px;width:80%"></div><div class="skeleton" style="height:12px;margin-top:8px;width:50%"></div></div>').join('')}</div>
  </section>`;
  reveal(app);
  $('#sort', app).value = state.sort;

  let timer, ctrl;
  const load = async () => {
    ctrl?.abort();
    ctrl = new AbortController();
    const params = new URLSearchParams({ q: state.q, category: state.category, sort: state.sort, limit: 120 });
    if (state.available) params.set('availability', 'available');
    let data;
    try { data = await api(`/api/books?${params}`, { signal: ctrl.signal }); } catch (e) { if (e.name !== 'AbortError') $('#grid', app).innerHTML = '<div class="empty"><div class="big">⚠︎</div><h3>The library is unavailable</h3><p>Please refresh in a moment.</p></div>'; return; }
    if (!app.isConnected) return;
    const total = data.categories.reduce((a, c) => a + c.n, 0);
    $('#chips', app).innerHTML = `<button class="chip ${!state.category ? 'active' : ''}" data-cat="">All <small>${total}</small></button>` +
      data.categories.map((c) => `<button class="chip ${state.category === c.category ? 'active' : ''}" data-cat="${esc(c.category)}">${esc(c.category)} <small>${c.n}</small></button>`).join('');
    $('#count', app).textContent = `${data.total} book${data.total === 1 ? '' : 's'}`;
    $('#grid', app).innerHTML = data.items.length ? data.items.map((b, i) => card(b, i)).join('') :
      `<div class="empty" style="grid-column:1/-1"><div class="big">🔍</div><h3>No books match</h3><p>Try another title, author or genre.</p><button class="btn btn-ghost sm" id="clear">Clear filters</button></div>`;
    $('#clear', app)?.addEventListener('click', () => { Object.assign(state, { q: '', category: '', available: false }); renderBrowse(app); });
  };

  $('#q', app).addEventListener('input', (e) => { state.q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(load, 220); });
  $('#sort', app).addEventListener('change', (e) => { state.sort = e.target.value; load(); });
  $('#avail', app).addEventListener('change', (e) => { state.available = e.target.checked; load(); });
  $('#chips', app).addEventListener('click', (e) => { const c = e.target.closest('[data-cat]'); if (c) { state.category = c.dataset.cat; load(); } });
  $('#grid', app).addEventListener('click', async (e) => {
    const quick = e.target.closest('[data-quick]');
    const cardEl = e.target.closest('.book-card');
    if (!cardEl) return;
    if (quick) {
      e.stopPropagation();
      quick.disabled = true;
      if (quick.dataset.quick === 'borrow') await act.borrow(cardEl.dataset.id, cardEl.querySelector('.cover'));
      else if (quick.dataset.quick === 'reserve') await act.reserve(cardEl.dataset.id);
      else openBook(cardEl.dataset.id);
      quick.disabled = false;
      return;
    }
    openBook(cardEl.dataset.id);
  });
  const onChange = () => { if (app.isConnected) load(); else window.removeEventListener('library:changed', onChange); };
  window.addEventListener('library:changed', onChange);
  load();
  return () => window.removeEventListener('library:changed', onChange);
}

function card(b, i) {
  const action = b.myLoan ? '<button class="quick on" data-quick="open">On shelf ✓</button>'
    : b.myReservation?.status === 'ready' || b.available > 0 ? '<button class="quick" data-quick="borrow">Borrow</button>'
      : b.myReservation ? '<button class="quick on" data-quick="open">Waitlisted</button>'
        : '<button class="quick" data-quick="reserve">Waitlist</button>';
  return `<article class="book-card" data-id="${esc(b.id)}" style="--i:${Math.min(i, 20)}" tabindex="0" aria-label="${esc(b.title)} by ${esc(b.author)}">
    <div class="tilt">${cover(b)}<div class="glare"></div><div class="card-badges">${availabilityTag(b)}</div></div>
    <div class="card-meta"><h3>${esc(b.title)}</h3><div class="by">${esc(b.author)}</div>
      <div class="card-foot">${b.rating ? `<span>${stars(b.rating)} <small class="muted">${b.reviewCount}</small></span>` : '<small class="muted">No ratings yet</small>'}${action}</div></div>
  </article>`;
}
