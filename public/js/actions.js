// Lending actions shared by every view.
import { api, store, refreshMe, changed } from './api.js';
import { toast, fmtDate } from './ui.js';
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
  return run(async () => {
    const r = await api('/api/loans', { method: 'POST', body: { bookId } });
    flyToShelf(coverEl);
    return r;
  }, (r) => `Borrowed! It's on your shelf — due back ${fmtDate(r.dueAt)}.`);
}

export async function reserve(bookId) {
  if (!(await requireAuth())) return false;
  return run(() => api('/api/reservations', { method: 'POST', body: { bookId } }),
    (r) => `You're #${r.position} on the waitlist. We'll hold the next copy for you.`);
}

export const cancelReservation = (id) => run(() => api(`/api/reservations/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Removed from the waitlist.');

export async function returnLoan(loanId, sourceEl) {
  const r = await run(() => api(`/api/loans/${encodeURIComponent(loanId)}/return`, { method: 'POST', body: {} }), 'Returned — your credit is back. Thank you!');
  if (r && sourceEl) {
    const b = sourceEl.getBoundingClientRect();
    confetti(b.left + b.width / 2, b.top + b.height / 2, 30);
  }
  return r;
}

export const renew = (loanId) => run(() => api(`/api/loans/${encodeURIComponent(loanId)}/renew`, { method: 'POST', body: {} }),
  (r) => `Renewed — new due date ${fmtDate(r.dueAt)}.`);
