// Lending actions shared by every view.
import { api, store, refreshMe, changed } from './api.js';
import { toast, fmtDate, modal, esc, confirmDialog } from './ui.js';
import { flyToShelf, confetti } from './fx.js';
import { openAuth } from './views/auth.js';

export async function requireAuth(mode = 'register') {
  if (store.me) return true;
  return openAuth(mode);
}

async function run(fn, success) {
  try {
    const result = await fn();
    await refreshMe();
    changed();
    if (success) toast(typeof success === 'function' ? success(result) : success);
    return result || true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

export async function borrow(bookId, coverEl) {
  if (!(await requireAuth())) return false;
  const r = await run(async () => {
    const res = await api('/api/loans', { method: 'POST', body: { bookId } });
    flyToShelf(coverEl);
    return res;
  }, (res) => `Borrowed! Due back ${fmtDate(res.dueAt)}.`);
  if (r) {
    const info = store.tenant?.pickupInfo || 'Collect your book from the Open Shelf desk at your library within 2 days. When you are done, hand it back at the same desk or any Open Shelf drop box.';
    setTimeout(() => modal(`<span class="eyebrow">📦 Next step</span><h2 style="margin-top:16px">Go get your <em>book.</em></h2>
      <p class="lead">${esc(info)}</p>
      <div class="copies" style="margin-bottom:22px"><b>Return by ${fmtDate(r.dueAt)}</b><small>You can see this any time on your shelf. No fines — the credit comes back when you return it.</small></div>
      <div class="detail-actions"><a class="btn btn-primary" href="#/shelf" data-close-modal>See my shelf</a></div>`), 900);
  }
  return r;
}

export async function reserve(bookId) {
  if (!(await requireAuth())) return false;
  return run(() => api('/api/reservations', { method: 'POST', body: { bookId } }),
    (r) => `You're #${r.position} on the waitlist. We'll hold the next copy for you.`);
}

export const cancelReservation = (id) => run(() => api(`/api/reservations/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Removed from the waitlist.');

export async function returnLoan(loanId, sourceEl) {
  const info = store.tenant?.pickupInfo || 'Collect your book from the Open Shelf desk at your library within 2 days. When you are done, hand it back at the same desk or any Open Shelf drop box.';
  if (!(await confirmDialog('Have you handed the book back?', `Only confirm once the book is back at the library desk or a drop box. ${info}`, { confirm: "Yes, I've returned it" }))) return false;
  const r = await run(() => api(`/api/loans/${encodeURIComponent(loanId)}/return`, { method: 'POST', body: {} }), 'Returned — your credit is back. Thank you!');
  if (r && sourceEl) {
    const b = sourceEl.getBoundingClientRect();
    confetti(b.left + b.width / 2, b.top + b.height / 2, 30);
  }
  return r;
}

export const renew = (loanId) => run(() => api(`/api/loans/${encodeURIComponent(loanId)}/renew`, { method: 'POST', body: {} }),
  (r) => `Renewed — new due date ${fmtDate(r.dueAt)}.`);
