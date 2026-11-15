'use strict';
/**
 * Core lending domain: catalogue queries, borrowing, returns, renewals,
 * waitlists and reviews. All state changes run inside a single transaction;
 * webhooks fire only after the transaction commits.
 */
const { one, all, run, tx, now, id } = require('../db');
const { HttpError } = require('../http');
const { notify, emit, audit } = require('../events');
const { RESERVATION_HOLD_HOURS, RENEW_DAYS, MAX_RENEWALS } = require('../config');

const DAY = 86_400_000;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const coverFor = (b) => b.cover || (b.isbn ? `https://covers.openlibrary.org/b/isbn/${b.isbn}-L.jpg?default=false` : '');

/** Run fn in a transaction and dispatch collected webhook events once it commits. */
function withEvents(tenantId, fn) {
  const events = [];
  const result = tx(() => fn(events));
  for (const [name, data] of events) emit(tenantId, name, data);
  return result;
}

// ---------------------------------------------------------------- catalogue

const SORTS = {
  new: 'created_at DESC, title',
  title: 'title COLLATE NOCASE',
  popular: 'times_borrowed DESC, title',
  rating: 'rating DESC NULLS LAST, review_count DESC, title',
  available: '(total_copies - on_loan - held) DESC, title',
};

function bookQuery(tenantId, viewerId, { q = '', category = '', includeArchived = false, bookId = '' } = {}) {
  const v = viewerId || '';
  const params = [v, v, v, v, v, tenantId];
  let where = 'b.tenant_id=?';
  if (!includeArchived) where += ' AND b.archived=0';
  if (bookId) { where += ' AND b.id=?'; params.push(bookId); }
  if (q) { where += " AND lower(b.title||' '||b.author||' '||b.category||' '||COALESCE(b.isbn,'')) LIKE ?"; params.push(`%${q.toLowerCase()}%`); }
  if (category) { where += ' AND b.category=?'; params.push(category); }
  const sql = `SELECT b.*,
      (SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id AND l.status='active') AS on_loan,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status='ready' AND r.user_id<>?) AS held,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status='waiting') AS queue,
      (SELECT ROUND(AVG(rating),1) FROM reviews v WHERE v.book_id=b.id) AS rating,
      (SELECT COUNT(*) FROM reviews v WHERE v.book_id=b.id) AS review_count,
      (SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id) AS times_borrowed,
      (SELECT id FROM loans l WHERE l.book_id=b.id AND l.user_id=? AND l.status='active') AS my_loan_id,
      (SELECT due_at FROM loans l WHERE l.book_id=b.id AND l.user_id=? AND l.status='active') AS my_loan_due,
      (SELECT id FROM reservations r WHERE r.book_id=b.id AND r.user_id=? AND r.status IN ('waiting','ready')) AS my_res_id,
      (SELECT status FROM reservations r WHERE r.book_id=b.id AND r.user_id=? AND r.status IN ('waiting','ready')) AS my_res_status
    FROM books b WHERE ${where}`;
  return { sql, params };
}

function toBook(b) {
  return {
    id: b.id, title: b.title, author: b.author, category: b.category, condition: b.condition,
    description: b.description, isbn: b.isbn || null, cover: coverFor(b),
    totalCopies: b.total_copies, onLoan: b.on_loan,
    available: Math.max(0, b.total_copies - b.on_loan - b.held),
    queue: b.queue, rating: b.rating, reviewCount: b.review_count, timesBorrowed: b.times_borrowed,
    archived: !!b.archived, createdAt: b.created_at,
    myLoan: b.my_loan_id ? { id: b.my_loan_id, dueAt: b.my_loan_due } : null,
    myReservation: b.my_res_id ? { id: b.my_res_id, status: b.my_res_status } : null,
  };
}

function listBooks(tenantId, viewerId, opts = {}) {
  const { sql, params } = bookQuery(tenantId, viewerId, opts);
  const avail = opts.availability === 'available' ? 'WHERE (total_copies - on_loan - held) > 0'
    : opts.availability === 'borrowed' ? 'WHERE (total_copies - on_loan - held) <= 0' : '';
  const order = SORTS[opts.sort] || SORTS.new;
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const items = all(`SELECT * FROM (${sql}) x ${avail} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(toBook);
  const total = one(`SELECT COUNT(*) AS n FROM (${sql}) x ${avail}`, ...params).n;
  const categories = all('SELECT category, COUNT(*) AS n FROM books WHERE tenant_id=? AND archived=0 GROUP BY category ORDER BY category', tenantId);
  return { items, total, limit, offset, categories };
}

function getBook(tenantId, viewerId, bookId, { includeArchived = false } = {}) {
  const { sql, params } = bookQuery(tenantId, viewerId, { bookId, includeArchived });
  const row = one(sql, ...params);
  if (!row) throw new HttpError(404, 'Book not found.');
  const book = toBook(row);
  if (book.myReservation?.status === 'waiting') book.myReservation.position = queuePosition(book.myReservation.id);
  book.reviews = all(`SELECT v.id, v.rating, v.body, v.created_at AS createdAt, u.name FROM reviews v JOIN users u ON u.id=v.user_id
    WHERE v.book_id=? ORDER BY v.created_at DESC LIMIT 30`, bookId).map((r) => ({ ...r, name: r.name.split(' ')[0] }));
  book.canReview = !!(viewerId && one('SELECT id FROM loans WHERE book_id=? AND user_id=? LIMIT 1', bookId, viewerId));
  return book;
}

function queuePosition(reservationId) {
  const r = one('SELECT book_id, created_at FROM reservations WHERE id=?', reservationId);
  if (!r) return null;
  return one("SELECT COUNT(*) AS n FROM reservations WHERE book_id=? AND status='waiting' AND created_at<=?", r.book_id, r.created_at).n;
}

/** Copies this user can borrow right now (ready holds for other members are excluded). */
function availableFor(bookId, userId) {
  const b = one('SELECT total_copies FROM books WHERE id=?', bookId);
  const onLoan = one("SELECT COUNT(*) AS n FROM loans WHERE book_id=? AND status='active'", bookId).n;
  const held = one("SELECT COUNT(*) AS n FROM reservations WHERE book_id=? AND status='ready' AND user_id<>?", bookId, userId || '').n;
  return b.total_copies - onLoan - held;
}

// ---------------------------------------------------------------- lending

function borrow(user, bookId) {
  const tenant = one('SELECT * FROM tenants WHERE id=?', user.tenant_id);
  const result = withEvents(user.tenant_id, (events) => {
    const u = one('SELECT id, credits, status FROM users WHERE id=?', user.id);
    if (u.status !== 'active') throw new HttpError(403, 'Your membership is suspended. Please contact the library.');
    const book = one('SELECT * FROM books WHERE id=? AND tenant_id=? AND archived=0', bookId, user.tenant_id);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (one("SELECT id FROM loans WHERE book_id=? AND user_id=? AND status='active'", bookId, u.id)) throw new HttpError(409, 'This book is already on your shelf.');
    if (availableFor(bookId, u.id) < 1) throw new HttpError(409, 'All copies are on loan right now. Join the waitlist and we will hold the next copy for you.', 'unavailable');
    if (u.credits < 1) throw new HttpError(402, 'You need a credit to borrow. Return a book or top up your membership.', 'no_credits');

    const loanId = id();
    const borrowedAt = now();
    const dueAt = new Date(Date.now() + tenant.loan_days * DAY).toISOString();
    run("INSERT INTO loans(id,tenant_id,book_id,user_id,status,borrowed_at,due_at) VALUES(?,?,?,?,'active',?,?)", loanId, user.tenant_id, bookId, u.id, borrowedAt, dueAt);
    run('UPDATE users SET credits=credits-1 WHERE id=?', u.id);
    run('INSERT INTO credit_ledger(id,user_id,loan_id,delta,reason,created_at) VALUES(?,?,?,?,?,?)', id(), u.id, loanId, -1, 'borrow', borrowedAt);
    run("UPDATE reservations SET status='fulfilled' WHERE book_id=? AND user_id=? AND status IN ('waiting','ready')", bookId, u.id);
    notify(u.id, 'loan', `You borrowed “${book.title}”`, `Enjoy it! Please return it by ${fmtDate(dueAt)}.`);
    events.push(['loan.created', { loanId, bookId, title: book.title, userId: u.id, dueAt }]);
    return { loanId, dueAt, credits: u.credits - 1 };
  });
  audit(user.tenant_id, user, 'loan.created', result.loanId, { bookId });
  return result;
}

/** Return a loan. Members may only return their own; staff (actor.staff) may check in any loan in their tenant. */
function returnLoan(tenantId, loanId, actor) {
  const result = withEvents(tenantId, (events) => {
    const loan = one("SELECT l.*, b.title FROM loans l JOIN books b ON b.id=l.book_id WHERE l.id=? AND l.tenant_id=? AND l.status='active'", loanId, tenantId);
    if (!loan || (!actor.staff && loan.user_id !== actor.id)) throw new HttpError(404, 'Active loan not found.');
    const at = now();
    run("UPDATE loans SET status='returned', returned_at=? WHERE id=?", at, loanId);
    run('UPDATE users SET credits=credits+1 WHERE id=?', loan.user_id);
    run('INSERT INTO credit_ledger(id,user_id,loan_id,delta,reason,created_at) VALUES(?,?,?,?,?,?)', id(), loan.user_id, loanId, 1, 'return', at);
    notify(loan.user_id, 'return', `“${loan.title}” returned`, 'Your credit is back. Ready for the next story?');
    events.push(['loan.returned', { loanId, bookId: loan.book_id, title: loan.title, userId: loan.user_id, late: loan.due_at < at }]);
    promoteWaitlist(loan.book_id, events);
    return { ok: true, credits: one('SELECT credits FROM users WHERE id=?', loan.user_id).credits };
  });
  audit(tenantId, actor, actor.staff ? 'loan.checked_in' : 'loan.returned', loanId);
  return result;
}

function renew(user, loanId) {
  const result = withEvents(user.tenant_id, (events) => {
    const loan = one("SELECT l.*, b.title FROM loans l JOIN books b ON b.id=l.book_id WHERE l.id=? AND l.user_id=? AND l.status='active'", loanId, user.id);
    if (!loan) throw new HttpError(404, 'Active loan not found.');
    if (loan.renewals >= MAX_RENEWALS) throw new HttpError(409, 'This loan has already been renewed. Please return it when you are done.');
    if (one("SELECT id FROM reservations WHERE book_id=? AND status='waiting' LIMIT 1", loan.book_id)) throw new HttpError(409, 'Another reader is waiting for this book, so it cannot be renewed.');
    const dueAt = new Date(new Date(loan.due_at).getTime() + RENEW_DAYS * DAY).toISOString();
    run('UPDATE loans SET due_at=?, renewals=renewals+1, overdue_notified=0 WHERE id=?', dueAt, loanId);
    events.push(['loan.renewed', { loanId, bookId: loan.book_id, userId: user.id, dueAt }]);
    return { loanId, dueAt };
  });
  audit(user.tenant_id, user, 'loan.renewed', loanId);
  return result;
}

/** Hand freed copies to the next members in the waitlist (FIFO). */
function promoteWaitlist(bookId, events) {
  const book = one('SELECT id, title, tenant_id, total_copies FROM books WHERE id=?', bookId);
  for (;;) {
    const onLoan = one("SELECT COUNT(*) AS n FROM loans WHERE book_id=? AND status='active'", bookId).n;
    const ready = one("SELECT COUNT(*) AS n FROM reservations WHERE book_id=? AND status='ready'", bookId).n;
    if (book.total_copies - onLoan - ready < 1) return;
    const next = one("SELECT * FROM reservations WHERE book_id=? AND status='waiting' ORDER BY created_at LIMIT 1", bookId);
    if (!next) return;
    const expiresAt = new Date(Date.now() + RESERVATION_HOLD_HOURS * 3_600_000).toISOString();
    run("UPDATE reservations SET status='ready', ready_at=?, expires_at=? WHERE id=?", now(), expiresAt, next.id);
    notify(next.user_id, 'reservation', `“${book.title}” is ready for you`, `We are holding a copy until ${fmtDate(expiresAt)}. Borrow it from the book page.`);
    events.push(['reservation.ready', { reservationId: next.id, bookId, userId: next.user_id, expiresAt }]);
  }
}

function reserve(user, bookId) {
  const result = withEvents(user.tenant_id, (events) => {
    const book = one('SELECT * FROM books WHERE id=? AND tenant_id=? AND archived=0', bookId, user.tenant_id);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (one("SELECT id FROM loans WHERE book_id=? AND user_id=? AND status='active'", bookId, user.id)) throw new HttpError(409, 'This book is already on your shelf.');
    if (one("SELECT id FROM reservations WHERE book_id=? AND user_id=? AND status IN ('waiting','ready')", bookId, user.id)) throw new HttpError(409, 'You are already on the waitlist for this book.');
    if (availableFor(bookId, user.id) > 0) throw new HttpError(409, 'A copy is available now — you can borrow it straight away.');
    const resId = id();
    run("INSERT INTO reservations(id,tenant_id,book_id,user_id,status,created_at) VALUES(?,?,?,?,'waiting',?)", resId, user.tenant_id, bookId, user.id, now());
    events.push(['reservation.created', { reservationId: resId, bookId, userId: user.id }]);
    return { reservationId: resId, position: queuePosition(resId) };
  });
  audit(user.tenant_id, user, 'reservation.created', result.reservationId, { bookId });
  return result;
}

function cancelReservation(user, resId) {
  return withEvents(user.tenant_id, (events) => {
    const r = one("SELECT * FROM reservations WHERE id=? AND user_id=? AND status IN ('waiting','ready')", resId, user.id);
    if (!r) throw new HttpError(404, 'Reservation not found.');
    run("UPDATE reservations SET status='cancelled' WHERE id=?", resId);
    if (r.status === 'ready') promoteWaitlist(r.book_id, events);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- reviews & shelf

function addReview(user, bookId, rating, body) {
  if (!one('SELECT id FROM books WHERE id=? AND tenant_id=?', bookId, user.tenant_id)) throw new HttpError(404, 'Book not found.');
  if (!one('SELECT id FROM loans WHERE book_id=? AND user_id=? LIMIT 1', bookId, user.id)) throw new HttpError(403, 'Borrow this book before reviewing it.');
  run(`INSERT INTO reviews(id,book_id,user_id,rating,body,created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(book_id,user_id) DO UPDATE SET rating=excluded.rating, body=excluded.body, created_at=excluded.created_at`,
  id(), bookId, user.id, rating, body, now());
  return { ok: true };
}

function shelf(user) {
  const t = now();
  const loans = all(`SELECT l.id, l.status, l.borrowed_at AS borrowedAt, l.due_at AS dueAt, l.returned_at AS returnedAt, l.renewals,
      b.id AS bookId, b.title, b.author, b.cover, b.isbn,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status='waiting') AS queue
    FROM loans l JOIN books b ON b.id=l.book_id WHERE l.user_id=? ORDER BY l.borrowed_at DESC LIMIT 100`, user.id)
    .map((l) => ({ ...l, cover: coverFor(l), overdue: l.status === 'active' && l.dueAt < t, canRenew: l.status === 'active' && l.renewals < MAX_RENEWALS && l.queue === 0 }));
  const reservations = all(`SELECT r.id, r.status, r.created_at AS createdAt, r.expires_at AS expiresAt, b.id AS bookId, b.title, b.author, b.cover, b.isbn
    FROM reservations r JOIN books b ON b.id=r.book_id WHERE r.user_id=? AND r.status IN ('waiting','ready') ORDER BY r.created_at`, user.id)
    .map((r) => ({ ...r, cover: coverFor(r), position: r.status === 'waiting' ? queuePosition(r.id) : 0 }));
  return {
    active: loans.filter((l) => l.status === 'active'),
    history: loans.filter((l) => l.status !== 'active'),
    reservations,
    stats: {
      booksRead: loans.filter((l) => l.status === 'returned').length,
      totalBorrowed: loans.length,
      reviews: one('SELECT COUNT(*) AS n FROM reviews WHERE user_id=?', user.id).n,
    },
  };
}

// ---------------------------------------------------------------- background jobs

function runJobs() {
  const t = now();
  const overdue = all("SELECT l.*, b.title FROM loans l JOIN books b ON b.id=l.book_id WHERE l.status='active' AND l.due_at<? AND l.overdue_notified=0", t);
  for (const l of overdue) {
    withEvents(l.tenant_id, (events) => {
      run('UPDATE loans SET overdue_notified=1 WHERE id=?', l.id);
      notify(l.user_id, 'overdue', `“${l.title}” is overdue`, 'Please return it so the next reader can enjoy it.');
      events.push(['loan.overdue', { loanId: l.id, bookId: l.book_id, userId: l.user_id, dueAt: l.due_at }]);
    });
  }
  const expired = all("SELECT r.*, b.title FROM reservations r JOIN books b ON b.id=r.book_id WHERE r.status='ready' AND r.expires_at<?", t);
  for (const r of expired) {
    withEvents(r.tenant_id, (events) => {
      run("UPDATE reservations SET status='expired' WHERE id=?", r.id);
      notify(r.user_id, 'reservation', `Your hold on “${r.title}” expired`, 'You can join the waitlist again at any time.');
      events.push(['reservation.expired', { reservationId: r.id, bookId: r.book_id, userId: r.user_id }]);
      promoteWaitlist(r.book_id, events);
    });
  }
  run('DELETE FROM sessions WHERE expires_at<?', Date.now());
  run('DELETE FROM sso_tokens WHERE expires_at<?', Date.now() - DAY);
  return { overdue: overdue.length, expiredHolds: expired.length };
}

module.exports = {
  listBooks, getBook, toBook, coverFor, borrow, returnLoan, renew, reserve, cancelReservation,
  addReview, shelf, runJobs, promoteWaitlist, withEvents,
};
