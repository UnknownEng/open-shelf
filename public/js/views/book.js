// Book detail modal: 3D cover, availability, lending actions and reviews.
import { api, store } from '../api.js';
import { modal, esc, book3d, stars, fmtDate, relTime, daysLeft, toast, $ } from '../ui.js';
import * as act from '../actions.js';

export async function openBook(bookId) {
  const m = modal('<div class="detail"><div class="skeleton" style="height:320px"></div><div class="skeleton" style="height:320px"></div></div>', { wide: true });
  const onChange = () => load();
  window.addEventListener('library:changed', onChange);
  const origClose = m.close;
  m.close = () => { window.removeEventListener('library:changed', onChange); origClose(); };
  m.el.querySelector('.modal-close').onclick = m.close;

  async function load() {
    let b;
    try { b = await api(`/api/books/${encodeURIComponent(bookId)}`); } catch (err) { toast(err.message, 'error'); m.close(); return; }
    if (!m.el.isConnected) return;
    const copies = Array.from({ length: Math.min(b.totalCopies, 12) }, (_, i) => `<i class="${i < b.available ? '' : 'out'}" style="animation-delay:${i * 80}ms"></i>`).join('');
    let primary;
    if (b.myLoan) {
      const d = daysLeft(b.myLoan.dueAt);
      primary = `<button class="btn btn-primary" data-act="return" data-id="${esc(b.myLoan.id)}">Return this book <span class="arrow">↩</span></button>
        <button class="btn btn-ghost" data-act="renew" data-id="${esc(b.myLoan.id)}">Renew</button>
        <p class="muted" style="width:100%">On your shelf · ${d >= 0 ? `due in ${d} day${d === 1 ? '' : 's'}` : `<b style="color:var(--bad)">${-d} days overdue</b>`} (${fmtDate(b.myLoan.dueAt)})</p>`;
    } else if (b.myReservation?.status === 'ready' || (b.available > 0)) {
      primary = `<button class="btn btn-primary lg magnetic" data-act="borrow"><span>Borrow for 1 credit</span> <span class="arrow">↗</span></button>
        ${b.myReservation?.status === 'ready' ? '<p class="muted" style="width:100%">🎉 We are holding a copy for you.</p>' : ''}`;
    } else if (b.myReservation) {
      primary = `<button class="btn btn-ghost" data-act="cancel" data-id="${esc(b.myReservation.id)}">Leave waitlist</button>
        <p class="muted" style="width:100%">You're <b>#${b.myReservation.position}</b> in line. We'll notify you when it's your turn.</p>`;
    } else {
      primary = `<button class="btn btn-primary lg" data-act="reserve">Join the waitlist <span class="arrow">→</span></button>
        <p class="muted" style="width:100%">All ${b.totalCopies} cop${b.totalCopies === 1 ? 'y is' : 'ies are'} out${b.queue ? ` · ${b.queue} reader${b.queue === 1 ? '' : 's'} waiting` : ''}.</p>`;
    }
    const credits = store.me ? `<span class="tag tag-mute">You have ${store.me.credits} credit${store.me.credits === 1 ? '' : 's'}</span>` : '';

    m.el.querySelector('.detail')?.remove();
    m.el.querySelector('.reviews')?.remove();
    m.el.insertAdjacentHTML('beforeend', `
      <div class="detail">
        <div class="detail-stage" style="--c1:var(--accent)">${book3d(b, '--ry:-24deg')}</div>
        <div class="detail-info">
          <div class="detail-tags"><span class="tag tag-mute">${esc(b.category)}</span><span class="tag tag-mute">${esc(b.condition)}</span>${b.rating ? `<span class="tag tag-warn">★ ${b.rating} · ${b.reviewCount}</span>` : ''}${credits}</div>
          <h2>${esc(b.title)}</h2>
          <div class="by">by ${esc(b.author)}</div>
          <p>${esc(b.description || 'A paperback ready for its next reader.')}</p>
          <div class="copies">
            <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>${b.available} of ${b.totalCopies} available</span><span class="muted">${store.tenant?.loanDays || 21}-day loan</span></div>
            <div class="copies-bar">${copies}</div>
            <small>Borrowed ${b.timesBorrowed} time${b.timesBorrowed === 1 ? '' : 's'}${b.isbn ? ` · ISBN ${esc(b.isbn)}` : ''}</small>
          </div>
          <div class="detail-actions">${primary}</div>
        </div>
      </div>
      <div class="reviews">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>Reader reviews</h3>${b.rating ? `<div>${stars(b.rating)} <b>${b.rating}</b> <span class="muted">(${b.reviewCount})</span></div>` : ''}</div>
        ${b.canReview ? `<form class="form card" id="reviewForm" style="padding:18px">
          <div class="star-input">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}"><label for="r${n}" title="${n} stars">★</label>`).join('')}</div>
          <label class="field"><textarea name="body" maxlength="1000" placeholder="What did you think? (optional)"></textarea></label>
          <button class="btn btn-soft sm" style="justify-self:start">Post review</button></form>` : ''}
        ${b.reviews.length ? b.reviews.map((r) => `<div class="review"><div class="review-head"><span>${esc(r.name)} ${stars(r.rating)}</span><small class="muted">${relTime(r.createdAt)}</small></div>${r.body ? `<p>${esc(r.body)}</p>` : ''}</div>`).join('')
          : '<p class="muted">No reviews yet. Borrow it and be the first to share your thoughts.</p>'}
      </div>`);

    const coverEl = m.el.querySelector('.book3d .front .cover');
    m.el.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const a = btn.dataset.act;
      if (a === 'borrow') await act.borrow(b.id, coverEl);
      if (a === 'reserve') await act.reserve(b.id);
      if (a === 'cancel') await act.cancelReservation(btn.dataset.id);
      if (a === 'return') await act.returnLoan(btn.dataset.id, btn);
      if (a === 'renew') await act.renew(btn.dataset.id);
      btn.disabled = false;
    }));
    $('#reviewForm', m.el)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget));
      if (!data.rating) { toast('Pick a star rating first.', 'error'); return; }
      try {
        await api(`/api/books/${encodeURIComponent(b.id)}/reviews`, { method: 'POST', body: { rating: Number(data.rating), body: data.body } });
        toast('Thanks for your review!');
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  load();
}
