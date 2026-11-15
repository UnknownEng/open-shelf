'use strict';
const { one, all, run, now } = require('../db');
const v = require('../validate');
const { HttpError } = require('../http');
const { limit } = require('../ratelimit');
const auth = require('../auth');
const lib = require('../services/library');
const { createMember } = require('../services/members');
const { audit } = require('../events');

module.exports = function publicRoutes(r) {
  const T = 'Members';

  r.get('/api/health', { summary: 'Service health check', tag: 'System' }, () => ({
    ok: true, version: require('../config').VERSION, uptimeSeconds: Math.round(process.uptime()),
    db: !!one('SELECT 1 AS ok'),
  }));

  r.get('/api/tenant', { summary: 'Public branding for the current library', tag: 'System' }, (ctx) => {
    const t = ctx.tenant;
    return { id: t.id, slug: t.slug, name: t.name, brandColor: t.brand_color, loanDays: t.loan_days, welcomeCredits: t.welcome_credits };
  });

  r.get('/api/stats/public', { summary: 'Headline library numbers for marketing pages', tag: 'System' }, (ctx) => {
    const tid = ctx.tenant.id;
    return {
      titles: one('SELECT COUNT(*) AS n FROM books WHERE tenant_id=? AND archived=0', tid).n,
      copies: one('SELECT COALESCE(SUM(total_copies),0) AS n FROM books WHERE tenant_id=? AND archived=0', tid).n,
      members: one('SELECT COUNT(*) AS n FROM users WHERE tenant_id=?', tid).n,
      loans: one('SELECT COUNT(*) AS n FROM loans WHERE tenant_id=?', tid).n,
      onLoanNow: one("SELECT COUNT(*) AS n FROM loans WHERE tenant_id=? AND status='active'", tid).n,
    };
  });

  // ---------------------------------------------------------------- auth
  r.post('/api/auth/register', { summary: 'Create a member account', tag: 'Auth' }, async (ctx) => {
    limit(`register:${ctx.ip}`, 10, 60 * 60_000);
    const b = await ctx.body();
    const member = createMember(ctx.tenant, {
      name: v.str(b.name, 'Name', { min: 2, max: 70 }),
      email: v.email(b.email),
      city: v.str(b.city, 'City', { min: 2, max: 70 }),
      password: v.password(b.password),
    });
    ctx.headers['Set-Cookie'] = auth.sessionCookie(auth.createSession(member.id));
    audit(ctx.tenant.id, member, 'member.registered', member.id);
    ctx.status = 201;
    return { user: auth.publicUser(member) };
  });

  r.post('/api/auth/login', { summary: 'Sign in with email and password', tag: 'Auth' }, async (ctx) => {
    limit(`login:${ctx.ip}`, 20, 15 * 60_000);
    const b = await ctx.body();
    const email = String(b.email || '').trim().toLowerCase();
    limit(`login-email:${email}`, 8, 15 * 60_000);
    const row = one('SELECT id, password_hash, status FROM users WHERE email=?', email);
    if (!auth.verifyPassword(String(b.password || ''), row?.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
    if (row.status === 'suspended') throw new HttpError(403, 'This membership is suspended. Please contact the library.');
    ctx.headers['Set-Cookie'] = auth.sessionCookie(auth.createSession(row.id));
    return { user: auth.publicUser(one(`${auth.USER_SQL} WHERE u.id=?`, row.id)) };
  });

  r.post('/api/auth/logout', { summary: 'End the current session', tag: 'Auth' }, (ctx) => {
    auth.destroySession(ctx.req);
    ctx.headers['Set-Cookie'] = auth.sessionCookie('', 0);
    return { ok: true };
  });

  r.get('/api/auth/sso', { summary: 'Redeem a one-time partner login link (redirects into the app)', tag: 'Auth' }, (ctx) => {
    limit(`sso:${ctx.ip}`, 30, 15 * 60_000);
    const tok = String(ctx.query.get('token') || '');
    const row = tok && one('SELECT * FROM sso_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?', auth.sha256(tok), Date.now());
    if (!row) return ctx.redirect('/#/?sso=expired');
    run('UPDATE sso_tokens SET used_at=? WHERE token_hash=?', now(), row.token_hash);
    ctx.headers['Set-Cookie'] = auth.sessionCookie(auth.createSession(row.user_id));
    return ctx.redirect('/#/shelf');
  });

  // ---------------------------------------------------------------- account
  r.get('/api/me', { summary: 'Current member, or null when signed out', tag: T }, (ctx) => ({
    user: auth.publicUser(ctx.user),
    unread: ctx.user ? one('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', ctx.user.id).n : 0,
  }));

  r.patch('/api/me', { auth: 'user', summary: 'Update profile', tag: T }, async (ctx) => {
    const b = await ctx.body();
    const name = b.name === undefined ? ctx.user.name : v.str(b.name, 'Name', { min: 2, max: 70 });
    const city = b.city === undefined ? ctx.user.city : v.str(b.city, 'City', { min: 2, max: 70 });
    run('UPDATE users SET name=?, city=? WHERE id=?', name, city, ctx.user.id);
    return { user: auth.publicUser(one(`${auth.USER_SQL} WHERE u.id=?`, ctx.user.id)) };
  });

  r.post('/api/me/password', { auth: 'user', summary: 'Change password (signs out other sessions)', tag: T }, async (ctx) => {
    limit(`pw:${ctx.user.id}`, 5, 15 * 60_000);
    const b = await ctx.body();
    const row = one('SELECT password_hash FROM users WHERE id=?', ctx.user.id);
    if (row.password_hash !== 'sso-only' && !auth.verifyPassword(String(b.currentPassword || ''), row.password_hash)) throw new HttpError(401, 'Current password is incorrect.');
    run('UPDATE users SET password_hash=? WHERE id=?', auth.hashPassword(v.password(b.newPassword)), ctx.user.id);
    run('DELETE FROM sessions WHERE user_id=?', ctx.user.id);
    ctx.headers['Set-Cookie'] = auth.sessionCookie(auth.createSession(ctx.user.id));
    audit(ctx.tenant.id, ctx.user, 'member.password_changed', ctx.user.id);
    return { ok: true };
  });

  r.get('/api/me/shelf', { auth: 'user', summary: 'Active loans, waitlist, history and reading stats', tag: T }, (ctx) => lib.shelf(ctx.user));

  r.get('/api/credits', { auth: 'user', summary: 'Credit ledger', tag: T }, (ctx) =>
    all('SELECT delta, reason, created_at AS createdAt FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100', ctx.user.id));

  r.get('/api/notifications', { auth: 'user', summary: 'Latest notifications', tag: T }, (ctx) =>
    all('SELECT id, kind, title, body, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 40', ctx.user.id));

  r.post('/api/notifications/read', { auth: 'user', summary: 'Mark all notifications read', tag: T }, (ctx) => {
    run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', now(), ctx.user.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- catalogue
  r.get('/api/books', { summary: 'Search and filter the catalogue', tag: 'Catalogue' }, (ctx) => {
    const q = ctx.query;
    return lib.listBooks(ctx.tenant.id, ctx.user?.id, {
      q: (q.get('q') || '').slice(0, 100), category: q.get('category') || '', availability: q.get('availability') || '',
      sort: q.get('sort') || 'new', limit: q.get('limit'), offset: q.get('offset'),
    });
  });

  r.get('/api/books/:id', { summary: 'Book detail with availability and reviews', tag: 'Catalogue' }, (ctx) =>
    lib.getBook(ctx.tenant.id, ctx.user?.id, ctx.params.id));

  r.post('/api/books/:id/reviews', { auth: 'user', summary: 'Rate and review a book you borrowed', tag: 'Catalogue' }, async (ctx) => {
    const b = await ctx.body();
    lib.addReview(ctx.user, ctx.params.id, v.int(b.rating, 'Rating', { min: 1, max: 5 }), v.str(b.body, 'Review', { max: 1000, optional: true }));
    ctx.status = 201;
    return lib.getBook(ctx.tenant.id, ctx.user.id, ctx.params.id);
  });

  // ---------------------------------------------------------------- lending
  r.post('/api/loans', { auth: 'user', summary: 'Borrow a book for one credit', tag: 'Lending' }, async (ctx) => {
    limit(`borrow:${ctx.user.id}`, 30, 60_000);
    const b = await ctx.body();
    ctx.status = 201;
    return lib.borrow(ctx.user, v.str(b.bookId, 'Book', { max: 64 }));
  });

  r.post('/api/loans/:id/return', { auth: 'user', summary: 'Return a book and get the credit back', tag: 'Lending' }, (ctx) =>
    lib.returnLoan(ctx.user.tenant_id, ctx.params.id, ctx.user));

  r.post('/api/loans/:id/renew', { auth: 'user', summary: 'Extend a loan once if nobody is waiting', tag: 'Lending' }, (ctx) =>
    lib.renew(ctx.user, ctx.params.id));

  r.post('/api/reservations', { auth: 'user', summary: 'Join the waitlist for a book', tag: 'Lending' }, async (ctx) => {
    const b = await ctx.body();
    ctx.status = 201;
    return lib.reserve(ctx.user, v.str(b.bookId, 'Book', { max: 64 }));
  });

  r.delete('/api/reservations/:id', { auth: 'user', summary: 'Leave a waitlist', tag: 'Lending' }, (ctx) =>
    lib.cancelReservation(ctx.user, ctx.params.id));
};
