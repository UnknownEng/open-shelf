'use strict';
const crypto = require('node:crypto');
const { one, all, run, now, id } = require('../db');
const v = require('../validate');
const { HttpError } = require('../http');
const auth = require('../auth');
const lib = require('../services/library');
const { adjustCredits } = require('../services/members');
const { audit, emit } = require('../events');
const { PRODUCTION } = require('../config');

const CONDITIONS = ['Like new', 'Good', 'Well-loved'];

function bookInput(b, existing = {}) {
  const pick = (k) => (b[k] === undefined ? existing[k] : b[k]);
  return {
    title: v.str(pick('title'), 'Title', { min: 2, max: 150 }),
    author: v.str(pick('author'), 'Author', { min: 2, max: 100 }),
    category: v.str(pick('category') || 'Fiction', 'Genre', { max: 40 }),
    condition: v.oneOf(pick('condition'), 'Condition', CONDITIONS, 'Good'),
    description: v.str(pick('description'), 'Description', { max: 1000, optional: true }),
    cover: v.httpsUrl(pick('cover'), 'Cover link'),
    isbn: v.str(pick('isbn'), 'ISBN', { max: 17, optional: true }).replace(/[^0-9X]/gi, '') || null,
    totalCopies: v.int(b.totalCopies ?? existing.total_copies, 'Copies', { min: 0, max: 999, fallback: 1 }),
  };
}

function insertBook(tenantId, d) {
  const bookId = id();
  run('INSERT INTO books(id,tenant_id,title,author,category,condition,description,cover,isbn,total_copies,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    bookId, tenantId, d.title, d.author, d.category, d.condition, d.description, d.cover, d.isbn, d.totalCopies, now());
  return bookId;
}

const memberRow = (m) => ({
  id: m.id, name: m.name, email: m.email, city: m.city, role: m.role, status: m.status, credits: m.credits,
  activeLoans: m.active_loans, totalLoans: m.total_loans, overdue: m.overdue, createdAt: m.created_at, lastLoginAt: m.last_login_at, externalId: m.external_id,
});

function stats(tenantId) {
  const t = now();
  const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  const since = day(29);
  const perDay = (sql) => {
    const rows = Object.fromEntries(all(sql, tenantId, since).map((r) => [r.d, r.n]));
    return Array.from({ length: 30 }, (_, i) => { const d = day(29 - i); return { date: d, count: rows[d] || 0 }; });
  };
  const copies = one('SELECT COALESCE(SUM(total_copies),0) AS n FROM books WHERE tenant_id=? AND archived=0', tenantId).n;
  const onLoan = one("SELECT COUNT(*) AS n FROM loans WHERE tenant_id=? AND status='active'", tenantId).n;
  return {
    members: one('SELECT COUNT(*) AS n FROM users WHERE tenant_id=?', tenantId).n,
    newMembers30d: one('SELECT COUNT(*) AS n FROM users WHERE tenant_id=? AND created_at>=?', tenantId, since).n,
    activeMembers30d: one('SELECT COUNT(DISTINCT user_id) AS n FROM loans WHERE tenant_id=? AND borrowed_at>=?', tenantId, since).n,
    titles: one('SELECT COUNT(*) AS n FROM books WHERE tenant_id=? AND archived=0', tenantId).n,
    copies, onLoan,
    utilization: copies ? Math.round((onLoan / copies) * 100) : 0,
    overdue: one("SELECT COUNT(*) AS n FROM loans WHERE tenant_id=? AND status='active' AND due_at<?", tenantId, t).n,
    waitlist: one("SELECT COUNT(*) AS n FROM reservations WHERE tenant_id=? AND status IN ('waiting','ready')", tenantId).n,
    loans30d: one('SELECT COUNT(*) AS n FROM loans WHERE tenant_id=? AND borrowed_at>=?', tenantId, since).n,
    avgRating: one('SELECT ROUND(AVG(v.rating),2) AS n FROM reviews v JOIN books b ON b.id=v.book_id WHERE b.tenant_id=?', tenantId).n,
    onTimeRate: (() => {
      const r = one("SELECT COUNT(*) AS total, SUM(CASE WHEN returned_at<=due_at THEN 1 ELSE 0 END) AS ok FROM loans WHERE tenant_id=? AND status='returned'", tenantId);
      return r.total ? Math.round((r.ok / r.total) * 100) : 100;
    })(),
    loansPerDay: perDay("SELECT substr(borrowed_at,1,10) AS d, COUNT(*) AS n FROM loans WHERE tenant_id=? AND borrowed_at>=? GROUP BY d"),
    returnsPerDay: perDay("SELECT substr(returned_at,1,10) AS d, COUNT(*) AS n FROM loans WHERE tenant_id=? AND returned_at>=? GROUP BY d"),
    signupsPerDay: perDay('SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM users WHERE tenant_id=? AND created_at>=? GROUP BY d'),
    topBooks: all(`SELECT b.id, b.title, b.author, b.isbn, b.cover, COUNT(l.id) AS loans FROM books b JOIN loans l ON l.book_id=b.id
      WHERE b.tenant_id=? GROUP BY b.id ORDER BY loans DESC LIMIT 6`, tenantId).map((b) => ({ ...b, cover: lib.coverFor(b) })),
    genres: all(`SELECT b.category AS name, COUNT(DISTINCT b.id) AS titles, COUNT(l.id) AS loans FROM books b LEFT JOIN loans l ON l.book_id=b.id
      WHERE b.tenant_id=? AND b.archived=0 GROUP BY b.category ORDER BY loans DESC, titles DESC`, tenantId),
  };
}

module.exports = function adminRoutes(r) {
  const A = { auth: 'admin', tag: 'Admin' };
  const actor = (ctx) => ({ ...ctx.user, staff: true });

  r.get('/api/admin/stats', { ...A, summary: 'KPIs and 30-day trends for the library' }, (ctx) => stats(ctx.tenant.id));

  // ---------------------------------------------------------------- catalogue
  r.get('/api/admin/books', { ...A, summary: 'Full catalogue incl. archived titles' }, (ctx) =>
    lib.listBooks(ctx.tenant.id, null, { q: ctx.query.get('q') || '', includeArchived: true, sort: ctx.query.get('sort') || 'title', limit: 200, offset: ctx.query.get('offset') }));

  r.post('/api/admin/books', { ...A, summary: 'Add a title to the catalogue' }, async (ctx) => {
    const bookId = insertBook(ctx.tenant.id, bookInput(await ctx.body()));
    audit(ctx.tenant.id, ctx.user, 'book.created', bookId);
    ctx.status = 201;
    return lib.getBook(ctx.tenant.id, null, bookId);
  });

  r.patch('/api/admin/books/:id', { ...A, summary: 'Edit a title, its copies, or archive state' }, async (ctx) => {
    const existing = one('SELECT * FROM books WHERE id=? AND tenant_id=?', ctx.params.id, ctx.tenant.id);
    if (!existing) throw new HttpError(404, 'Book not found.');
    const b = await ctx.body();
    const d = bookInput(b, existing);
    const archived = b.archived === undefined ? existing.archived : Number(!!b.archived);
    run('UPDATE books SET title=?,author=?,category=?,condition=?,description=?,cover=?,isbn=?,total_copies=?,archived=? WHERE id=?',
      d.title, d.author, d.category, d.condition, d.description, d.cover, d.isbn, d.totalCopies, archived, existing.id);
    lib.withEvents(ctx.tenant.id, (events) => lib.promoteWaitlist(existing.id, events));
    audit(ctx.tenant.id, ctx.user, archived && !existing.archived ? 'book.archived' : 'book.updated', existing.id);
    return lib.getBook(ctx.tenant.id, null, existing.id, { includeArchived: true });
  });

  // ---------------------------------------------------------------- members
  r.get('/api/admin/members', { ...A, summary: 'Search members' }, (ctx) => {
    const q = `%${(ctx.query.get('q') || '').toLowerCase()}%`;
    return all(`SELECT u.*,
        (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id AND l.status='active') AS active_loans,
        (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id) AS total_loans,
        (SELECT COUNT(*) FROM loans l WHERE l.user_id=u.id AND l.status='active' AND l.due_at<?) AS overdue
      FROM users u WHERE u.tenant_id=? AND lower(u.name||' '||u.email) LIKE ? ORDER BY u.created_at DESC LIMIT 200`, now(), ctx.tenant.id, q).map(memberRow);
  });

  r.patch('/api/admin/members/:id', { ...A, summary: 'Change role/status or adjust credits' }, async (ctx) => {
    const m = one('SELECT * FROM users WHERE id=? AND tenant_id=?', ctx.params.id, ctx.tenant.id);
    if (!m) throw new HttpError(404, 'Member not found.');
    const b = await ctx.body();
    if (b.role !== undefined) {
      if (m.id === ctx.user.id) throw new HttpError(409, 'You cannot change your own role.');
      if (m.role === 'owner' && ctx.user.role !== 'owner') throw new HttpError(403, 'Only a platform owner can change this account.');
      const role = v.oneOf(b.role, 'Role', ctx.user.role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin']);
      run('UPDATE users SET role=? WHERE id=?', role, m.id);
      audit(ctx.tenant.id, ctx.user, 'member.role_changed', m.id, { from: m.role, to: role });
    }
    if (b.status !== undefined) {
      if (m.id === ctx.user.id) throw new HttpError(409, 'You cannot suspend yourself.');
      const status = v.oneOf(b.status, 'Status', ['active', 'suspended']);
      run('UPDATE users SET status=? WHERE id=?', status, m.id);
      if (status === 'suspended') run('DELETE FROM sessions WHERE user_id=?', m.id);
      audit(ctx.tenant.id, ctx.user, `member.${status === 'active' ? 'reactivated' : 'suspended'}`, m.id);
    }
    if (b.creditDelta !== undefined) {
      const delta = v.int(b.creditDelta, 'Credit change', { min: -100, max: 100 });
      if (delta) {
        adjustCredits(m.id, delta, v.str(b.reason, 'Reason', { max: 60, optional: true }) || 'staff_adjustment');
        audit(ctx.tenant.id, ctx.user, 'member.credits_adjusted', m.id, { delta });
      }
    }
    return { ok: true };
  });

  r.get('/api/admin/members/:id', { ...A, summary: 'Member detail: profile, loans, waitlist and credit ledger' }, (ctx) => {
    const m = one(`${require('../auth').USER_SQL} WHERE u.id=? AND u.tenant_id=?`, ctx.params.id, ctx.tenant.id);
    if (!m) throw new HttpError(404, 'Member not found.');
    return {
      ...auth.publicUser(m), lastLoginAt: one('SELECT last_login_at AS t FROM users WHERE id=?', m.id).t, externalId: m.external_id,
      shelf: lib.shelf(m),
      ledger: all('SELECT delta, reason, created_at AS createdAt FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 50', m.id),
    };
  });

  r.get('/api/admin/export/:kind', { ...A, summary: 'Download CSV export: books, members, loans or audit' }, (ctx) => {
    const kind = v.oneOf(ctx.params.kind, 'Export', ['books', 'members', 'loans', 'audit']);
    const tid = ctx.tenant.id;
    const queries = {
      books: ["SELECT id,title,author,category,condition,isbn,total_copies,archived,created_at FROM books WHERE tenant_id=? ORDER BY title", tid],
      members: ['SELECT id,name,email,city,role,status,credits,external_id,created_at,last_login_at FROM users WHERE tenant_id=? ORDER BY created_at', tid],
      loans: [`SELECT l.id,b.title,u.name AS member,u.email,l.status,l.borrowed_at,l.due_at,l.returned_at,l.renewals
        FROM loans l JOIN books b ON b.id=l.book_id JOIN users u ON u.id=l.user_id WHERE l.tenant_id=? ORDER BY l.borrowed_at DESC`, tid],
      audit: ['SELECT created_at,actor_label,action,target,meta FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 5000', tid],
    };
    const rows = all(...queries[kind]);
    // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start of a cell).
    const cell = (val) => {
      let s = val === null || val === undefined ? '' : String(val);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const csv = [cols.join(','), ...rows.map((row) => cols.map((c) => cell(row[c])).join(','))].join('\r\n');
    audit(tid, ctx.user, 'export.downloaded', kind, { rows: rows.length });
    return { __raw: `﻿${csv}`, type: 'text/csv; charset=utf-8', filename: `openshelf-${kind}-${new Date().toISOString().slice(0, 10)}.csv` };
  });

  // ---------------------------------------------------------------- circulation
  r.get('/api/admin/loans', { ...A, summary: 'Loans by status: active, overdue, returned' }, (ctx) => {
    const status = v.oneOf(ctx.query.get('status'), 'Status', ['active', 'overdue', 'returned', 'all'], 'active');
    const t = now();
    const where = status === 'overdue' ? "l.status='active' AND l.due_at<?" : status === 'all' ? '?=?' : 'l.status=? ';
    const params = status === 'overdue' ? [t] : status === 'all' ? [1, 1] : [status];
    return all(`SELECT l.id, l.status, l.borrowed_at AS borrowedAt, l.due_at AS dueAt, l.returned_at AS returnedAt, l.renewals,
        b.title, b.id AS bookId, u.name AS member, u.email, u.id AS userId
      FROM loans l JOIN books b ON b.id=l.book_id JOIN users u ON u.id=l.user_id
      WHERE l.tenant_id=? AND ${where} ORDER BY l.borrowed_at DESC LIMIT 300`, ctx.tenant.id, ...params)
      .map((l) => ({ ...l, overdue: l.status === 'active' && l.dueAt < t }));
  });

  r.post('/api/admin/loans/:id/checkin', { ...A, summary: 'Staff check-in of a returned copy' }, (ctx) =>
    lib.returnLoan(ctx.tenant.id, ctx.params.id, actor(ctx)));

  r.get('/api/admin/reservations', { ...A, summary: 'Current waitlists and holds' }, (ctx) =>
    all(`SELECT r.id, r.status, r.created_at AS createdAt, r.expires_at AS expiresAt, b.title, u.name AS member, u.email
      FROM reservations r JOIN books b ON b.id=r.book_id JOIN users u ON u.id=r.user_id
      WHERE r.tenant_id=? AND r.status IN ('waiting','ready') ORDER BY r.created_at`, ctx.tenant.id));

  r.get('/api/admin/audit', { ...A, summary: 'Audit log (latest 200 events)' }, (ctx) =>
    all('SELECT id, actor_label AS actor, action, target, meta, created_at AS createdAt FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', ctx.tenant.id)
      .map((a) => ({ ...a, meta: JSON.parse(a.meta) })));

  // ---------------------------------------------------------------- tenant settings
  r.get('/api/admin/settings', { ...A, summary: 'Library settings' }, (ctx) => ctx.tenant);

  r.patch('/api/admin/settings', { ...A, summary: 'Update branding and lending rules' }, async (ctx) => {
    const b = await ctx.body();
    const t = ctx.tenant;
    const name = b.name === undefined ? t.name : v.str(b.name, 'Library name', { min: 2, max: 60 });
    const color = v.color(b.brandColor, t.brand_color);
    const loanDays = v.int(b.loanDays, 'Loan length', { min: 1, max: 120, fallback: t.loan_days });
    const welcome = v.int(b.welcomeCredits, 'Welcome credits', { min: 0, max: 50, fallback: t.welcome_credits });
    run('UPDATE tenants SET name=?, brand_color=?, loan_days=?, welcome_credits=? WHERE id=?', name, color, loanDays, welcome, t.id);
    audit(t.id, ctx.user, 'tenant.settings_updated', t.id, { name, color, loanDays, welcome });
    return one('SELECT * FROM tenants WHERE id=?', t.id);
  });

  // ---------------------------------------------------------------- partner API keys
  r.get('/api/admin/api-keys', { ...A, summary: 'List partner API keys' }, (ctx) =>
    all('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC', ctx.tenant.id));

  r.post('/api/admin/api-keys', { ...A, summary: 'Create a partner API key (shown once)' }, async (ctx) => {
    const b = await ctx.body();
    const name = v.str(b.name, 'Key name', { min: 2, max: 60 });
    const k = auth.newApiKey();
    const keyId = id();
    run('INSERT INTO api_keys(id,tenant_id,name,key_hash,prefix,created_at) VALUES(?,?,?,?,?,?)', keyId, ctx.tenant.id, name, k.hash, k.prefix, now());
    audit(ctx.tenant.id, ctx.user, 'api_key.created', keyId, { name });
    ctx.status = 201;
    return { id: keyId, name, prefix: k.prefix, key: k.raw };
  });

  r.delete('/api/admin/api-keys/:id', { ...A, summary: 'Revoke an API key' }, (ctx) => {
    const res = run('UPDATE api_keys SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL', now(), ctx.params.id, ctx.tenant.id);
    if (!res.changes) throw new HttpError(404, 'API key not found.');
    audit(ctx.tenant.id, ctx.user, 'api_key.revoked', ctx.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- webhooks
  r.get('/api/admin/webhooks', { ...A, summary: 'List webhooks with recent delivery health' }, (ctx) =>
    all(`SELECT w.id, w.url, w.events, w.active, w.created_at AS createdAt,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='delivered') AS delivered,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='failed') AS failed
      FROM webhooks w WHERE w.tenant_id=? ORDER BY w.created_at DESC`, ctx.tenant.id));

  r.post('/api/admin/webhooks', { ...A, summary: 'Subscribe a URL to events (secret shown once)' }, async (ctx) => {
    const b = await ctx.body();
    const url = v.httpsUrl(b.url, 'Webhook URL', { optional: false, allowLocalHttp: !PRODUCTION });
    const events = v.str(b.events || '*', 'Events', { max: 300 });
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const hookId = id();
    run('INSERT INTO webhooks(id,tenant_id,url,secret,events,created_at) VALUES(?,?,?,?,?,?)', hookId, ctx.tenant.id, url, secret, events, now());
    audit(ctx.tenant.id, ctx.user, 'webhook.created', hookId, { url, events });
    ctx.status = 201;
    return { id: hookId, url, events, secret };
  });

  r.post('/api/admin/webhooks/:id/test', { ...A, summary: 'Send a test ping event' }, (ctx) => {
    if (!one('SELECT id FROM webhooks WHERE id=? AND tenant_id=?', ctx.params.id, ctx.tenant.id)) throw new HttpError(404, 'Webhook not found.');
    emit(ctx.tenant.id, 'ping', { message: 'Hello from Open Shelf', webhookId: ctx.params.id });
    return { ok: true };
  });

  r.get('/api/admin/webhooks/:id/deliveries', { ...A, summary: 'Recent deliveries for a webhook' }, (ctx) =>
    all(`SELECT d.event, d.status, d.response_code AS responseCode, d.duration_ms AS durationMs, d.created_at AS createdAt
      FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.id=? AND w.tenant_id=? ORDER BY d.created_at DESC LIMIT 50`, ctx.params.id, ctx.tenant.id));

  r.delete('/api/admin/webhooks/:id', { ...A, summary: 'Delete a webhook' }, (ctx) => {
    const res = run('DELETE FROM webhooks WHERE id=? AND tenant_id=?', ctx.params.id, ctx.tenant.id);
    if (!res.changes) throw new HttpError(404, 'Webhook not found.');
    audit(ctx.tenant.id, ctx.user, 'webhook.deleted', ctx.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- platform owner: tenants
  r.get('/api/admin/tenants', { auth: 'owner', tag: 'Platform', summary: 'All white-label libraries' }, () =>
    all(`SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) AS members,
        (SELECT COUNT(*) FROM books b WHERE b.tenant_id=t.id AND b.archived=0) AS titles,
        (SELECT COUNT(*) FROM loans l WHERE l.tenant_id=t.id) AS loans FROM tenants t ORDER BY t.created_at`));

  r.post('/api/admin/tenants', { auth: 'owner', tag: 'Platform', summary: 'Provision a new white-label library' }, async (ctx) => {
    const b = await ctx.body();
    const slug = v.str(b.slug, 'Slug', { min: 2, max: 40 }).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, 'Slug may contain lowercase letters, numbers and dashes only.');
    if (one('SELECT id FROM tenants WHERE slug=?', slug)) throw new HttpError(409, 'That slug is taken.');
    const tenantId = id();
    run('INSERT INTO tenants(id,slug,name,brand_color,plan,created_at) VALUES(?,?,?,?,?,?)', tenantId, slug,
      v.str(b.name, 'Name', { min: 2, max: 60 }), v.color(b.brandColor, '#c8ff3d'), v.oneOf(b.plan, 'Plan', ['starter', 'growth', 'enterprise'], 'starter'), now());
    audit(ctx.tenant.id, ctx.user, 'tenant.created', tenantId, { slug });
    ctx.status = 201;
    return one('SELECT * FROM tenants WHERE id=?', tenantId);
  });
};

module.exports.bookInput = bookInput;
module.exports.insertBook = insertBook;
module.exports.stats = stats;
