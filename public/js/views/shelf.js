// Member shelf: wallet, stats, active loans with due rings, waitlist, history, ledger, profile.
import { api, store, refreshMe } from '../api.js';
import { esc, cover, fmtDate, relTime, daysLeft, toast, $ } from '../ui.js';
import { reveal } from '../fx.js';
import { openBook } from './book.js';
import { openAuth } from './auth.js';
import * as act from '../actions.js';

const REASONS = { welcome: 'Welcome credits', borrow: 'Borrowed a book', return: 'Returned a book', partner_grant: 'Credits from partner', staff_adjustment: 'Adjusted by library' };

export async function renderShelf(app) {
  if (!store.me) {
    app.innerHTML = `<section class="wrap"><div class="empty" style="padding-top:120px"><div class="big">📚</div><h3>Your shelf is waiting</h3><p>Sign in to see your loans, waitlist and credits.</p>
      <div class="hero-ctas" style="justify-content:center"><button class="btn btn-primary" id="si">Sign in</button><button class="btn btn-ghost" id="su">Create account</button></div></div></section>`;
    $('#si', app).onclick = () => openAuth('login');
    $('#su', app).onclick = () => openAuth('register');
    return;
  }
  const [shelf, ledger] = await Promise.all([api('/api/me/shelf'), api('/api/credits')]);
  if (!app.isConnected) return;
  const me = store.me;
  const loanDays = store.tenant?.loanDays || 21;

  app.innerHTML = `
  <section class="wrap">
    <div class="page-head"><div><span class="eyebrow" data-reveal>Your reading shelf</span><h1 data-reveal style="--i:1;margin-top:16px">Hi ${esc(me.name.split(' ')[0])}, <em class="grad-text">happy reading.</em></h1></div></div>
    <div class="shelf-top">
      <div class="card wallet" data-reveal>
        <span class="muted" style="font-weight:700;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase">Credit wallet</span>
        <div class="wallet-amount"><span class="coin">◈</span><b data-count="${me.credits}">0</b><span class="muted">credits<br>available</span></div>
        <p class="muted">One credit borrows one book. It comes back the moment you return.</p>
        <div class="detail-actions"><a class="btn btn-primary sm" href="#/browse">Find a book <span class="arrow">↗</span></a><button class="btn btn-ghost sm" id="editProfile">Profile & security</button></div>
      </div>
      <div class="stat-cards">
        ${[['On shelf', shelf.active.length], ['Books read', shelf.stats.booksRead], ['Reviews', shelf.stats.reviews]].map(([l, n], i) => `<div class="card stat" data-reveal style="--i:${i + 1}"><b data-count="${n}">0</b><span>${l}</span></div>`).join('')}
      </div>
    </div>

    <div class="shelf-section">
      <h2>On your shelf <span class="tag tag-mute">${shelf.active.length}</span></h2>
      ${shelf.active.length ? `<div class="loans">${shelf.active.map((l, i) => {
    const d = daysLeft(l.dueAt);
    const pct = Math.max(0, Math.min(1, d / loanDays));
    const color = l.overdue ? 'var(--bad)' : d <= 3 ? 'var(--warn)' : 'var(--good)';
    return `<article class="card loan" data-reveal style="--i:${i}">
          <button data-open="${esc(l.bookId)}">${cover(l)}</button>
          <div><h4>${esc(l.title)}</h4><div class="by">${esc(l.author)}</div>
            <div class="by" style="margin-top:6px">${l.overdue ? `<b style="color:var(--bad)">Overdue since ${fmtDate(l.dueAt)}</b>` : `Due ${fmtDate(l.dueAt)}`}${l.renewals ? ' · renewed' : ''}</div>
            <div class="loan-actions"><button class="btn btn-primary sm" data-return="${esc(l.id)}">Return</button>${l.canRenew ? `<button class="btn btn-ghost sm" data-renew="${esc(l.id)}">Renew +14d</button>` : ''}</div></div>
          <div class="ring-prog" style="--c:${color}"><svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="28"/><circle class="fg" cx="32" cy="32" r="28" data-pct="${pct}"/></svg><b>${Math.abs(d)}</b><small>${l.overdue ? 'days late' : 'days left'}</small></div>
        </article>`;
  }).join('')}</div>` : '<div class="card empty" style="padding:50px"><div class="big">🌙</div><h3>Nothing on loan</h3><p>Your next favourite story is one tap away.</p><a class="btn btn-primary sm" href="#/browse">Browse books</a></div>'}
    </div>

    ${shelf.reservations.length ? `<div class="shelf-section"><h2>Waitlist <span class="tag tag-mute">${shelf.reservations.length}</span></h2><div class="loans">
      ${shelf.reservations.map((r, i) => `<article class="card loan" data-reveal style="--i:${i}"><button data-open="${esc(r.bookId)}">${cover(r)}</button>
        <div><h4>${esc(r.title)}</h4><div class="by">${esc(r.author)}</div>
          <div style="margin-top:8px">${r.status === 'ready' ? `<span class="tag tag-good">Ready — held until ${fmtDate(r.expiresAt)}</span>` : `<span class="tag tag-info">#${r.position} in line</span>`}</div>
          <div class="loan-actions">${r.status === 'ready' ? `<button class="btn btn-primary sm" data-borrow="${esc(r.bookId)}">Borrow now</button>` : ''}<button class="btn btn-ghost sm" data-cancel="${esc(r.id)}">Leave</button></div></div></article>`).join('')}
    </div></div>` : ''}

    ${shelf.history.length ? `<div class="shelf-section"><h2>Reading history</h2><div class="history">
      ${shelf.history.slice(0, 24).map((l, i) => `<div data-reveal style="--i:${i % 8}"><button data-open="${esc(l.bookId)}" style="width:100%">${cover(l)}</button><small class="muted">${l.returnedAt ? `Returned ${relTime(l.returnedAt)}` : ''}</small></div>`).join('')}
    </div></div>` : ''}

    <div class="shelf-section"><h2>Credit history</h2><div class="card" style="padding:6px 20px"><div class="ledger">
      ${ledger.length ? ledger.slice(0, 20).map((x) => `<div class="ledger-row"><span>${esc(REASONS[x.reason] || x.reason)}</span><small>${fmtDate(x.createdAt)}</small><b class="${x.delta < 0 ? 'neg' : 'pos'}">${x.delta > 0 ? '+' : ''}${x.delta}</b></div>`).join('') : '<p class="muted" style="padding:20px 0">No credit activity yet.</p>'}
    </div></div></div>
  </section>`;

  reveal(app);
  requestAnimationFrame(() => setTimeout(() => app.querySelectorAll('.ring-prog .fg').forEach((c) => { c.style.strokeDashoffset = String(176 * (1 - Number(c.dataset.pct))); }), 300));
  $('section', app).addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.open) return openBook(t.dataset.open);
    if (t.id === 'editProfile') return profileModal();
    t.disabled = true;
    if (t.dataset.return) await act.returnLoan(t.dataset.return, t);
    else if (t.dataset.renew) await act.renew(t.dataset.renew);
    else if (t.dataset.cancel) await act.cancelReservation(t.dataset.cancel);
    else if (t.dataset.borrow) await act.borrow(t.dataset.borrow, t.closest('.loan')?.querySelector('.cover'));
    t.disabled = false;
  });
  const onChange = () => { window.removeEventListener('library:changed', onChange); if (app.isConnected && location.hash.startsWith('#/shelf')) renderShelf(app); };
  window.addEventListener('library:changed', onChange);
  return () => window.removeEventListener('library:changed', onChange);
}

async function profileModal() {
  const { modal } = await import('../ui.js');
  const me = store.me;
  const m = modal(`<h2>Profile & <em>security</em></h2><p class="lead">${esc(me.email)} · member since ${fmtDate(me.createdAt)}</p>
    <form class="form" id="pf"><div class="field-row"><label class="field">Name<input name="name" value="${esc(me.name)}" maxlength="70"></label><label class="field">City<input name="city" value="${esc(me.city)}" maxlength="70"></label></div>
      <button class="btn btn-soft" style="justify-self:start">Save profile</button></form>
    <hr style="border:0;border-top:1px solid var(--line);margin:26px 0">
    <form class="form" id="pw"><label class="field">Current password<input type="password" name="currentPassword" autocomplete="current-password"></label>
      <label class="field">New password<input type="password" name="newPassword" minlength="10" autocomplete="new-password" placeholder="At least 10 characters"></label>
      <div class="form-error" id="pwErr"></div><button class="btn btn-soft" style="justify-self:start">Change password</button></form>`);
  $('#pf', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/me', { method: 'PATCH', body: Object.fromEntries(new FormData(e.currentTarget)) }); await refreshMe(); toast('Profile saved.'); } catch (err) { toast(err.message, 'error'); }
  });
  $('#pw', m.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) }); toast('Password changed. Other devices were signed out.'); m.close(); } catch (err) { $('#pwErr', m.el).textContent = err.message; }
  });
}
