'use strict';
/**
 * Partner API (v1) — for platforms that embed Open Shelf (universities, telcos,
 * e-commerce, HR/benefit platforms). Authenticated with tenant API keys:
 *   Authorization: Bearer osk_...
 * Typical integration: partner billing grants credits, partner SSO hands
 * members into the app with a one-time login link, webhooks report activity.
 */
const { one, all, run, tx } = require('../db');
const v = require('../validate');
const { HttpError } = require('../http');
const auth = require('../auth');
const lib = require('../services/library');
const { createMember, getMember, adjustCredits } = require('../services/members');
const { bookInput, insertBook, stats } = require('./admin');
const { audit } = require('../events');
const { SSO_TOKEN_MINUTES, PUBLIC_URL } = require('../config');

const P = { auth: 'partner', tag: 'Partner API v1' };
const partnerActor = (ctx) => ({ id: null, label: `api:${ctx.apiKey.prefix}`, staff: true });

function memberOf(ctx) {
  const m = one('SELECT id FROM users WHERE (id=? OR external_id=?) AND tenant_id=?', ctx.params.id, ctx.params.id, ctx.tenant.id);
  if (!m) throw new HttpError(404, 'Member not found.');
  return getMember(m.id);
}

module.exports = function partnerRoutes(r) {
  r.get('/api/v1/books', { ...P, summary: 'List catalogue (q, category, availability, sort, limit, offset)' }, (ctx) => {
    const q = ctx.query;
    return lib.listBooks(ctx.tenant.id, null, { q: q.get('q') || '', category: q.get('category') || '', availability: q.get('availability') || '', sort: q.get('sort') || 'title', limit: q.get('limit'), offset: q.get('offset') });
  });

  r.post('/api/v1/books', { ...P, summary: 'Add one book, or bulk import with {"books":[...]} (max 500)' }, async (ctx) => {
    const b = await ctx.body();
    const list = Array.isArray(b.books) ? b.books : [b];
    if (list.length > 500) throw new HttpError(400, 'Import at most 500 books per request.');
    const inputs = list.map((x, i) => {
      try { return bookInput(x || {}); } catch (e) { throw new HttpError(400, `Book ${i + 1}: ${e.message}`); }
    });
    const ids = tx(() => inputs.map((d) => insertBook(ctx.tenant.id, d)));
    audit(ctx.tenant.id, partnerActor(ctx), 'book.imported', null, { count: ids.length });
    ctx.status = 201;
    return { created: ids.length, ids };
  });

  r.get('/api/v1/members', { ...P, summary: 'List members (filter by email or externalId)' }, (ctx) => {
    const email = (ctx.query.get('email') || '').toLowerCase();
    const ext = ctx.query.get('externalId') || '';
    return all(`${auth.USER_SQL} WHERE u.tenant_id=? AND (?='' OR u.email=?) AND (?='' OR u.external_id=?) ORDER BY u.created_at DESC LIMIT 500`,
      ctx.tenant.id, email, email, ext, ext).map((u) => ({ ...auth.publicUser(u), externalId: u.external_id }));
  });

  r.post('/api/v1/members', { ...P, summary: 'Provision a member from your platform (SSO-only, no password)' }, async (ctx) => {
    const b = await ctx.body();
    const m = createMember(ctx.tenant, {
      name: v.str(b.name, 'Name', { min: 2, max: 70 }),
      email: v.email(b.email),
      city: v.str(b.city, 'City', { max: 70, optional: true }),
      externalId: v.str(b.externalId, 'externalId', { max: 120, optional: true }) || null,
      credits: b.credits === undefined ? undefined : v.int(b.credits, 'Credits', { min: 0, max: 100 }),
    });
    audit(ctx.tenant.id, partnerActor(ctx), 'member.provisioned', m.id);
    ctx.status = 201;
    return { ...auth.publicUser(m), externalId: m.external_id };
  });

  r.get('/api/v1/members/:id', { ...P, summary: 'Get a member by id or externalId, with active loans' }, (ctx) => {
    const m = memberOf(ctx);
    return { ...auth.publicUser(m), externalId: m.external_id, shelf: lib.shelf(m) };
  });

  r.post('/api/v1/members/:id/credits', { ...P, summary: 'Grant or remove credits (e.g. after a subscription payment)' }, async (ctx) => {
    const m = memberOf(ctx);
    const b = await ctx.body();
    const delta = v.int(b.delta, 'delta', { min: -100, max: 100 });
    if (!delta) throw new HttpError(400, 'delta must not be zero.');
    const result = adjustCredits(m.id, delta, v.str(b.reason, 'reason', { max: 60, optional: true }) || 'partner_grant');
    audit(ctx.tenant.id, partnerActor(ctx), 'member.credits_adjusted', m.id, { delta });
    return result;
  });

  r.post('/api/v1/members/:id/login-link', { ...P, summary: `Create a one-time SSO login link (valid ${SSO_TOKEN_MINUTES} minutes)` }, (ctx) => {
    const m = memberOf(ctx);
    if (m.status !== 'active') throw new HttpError(409, 'Member is suspended.');
    const t = auth.token();
    const expiresAt = Date.now() + SSO_TOKEN_MINUTES * 60_000;
    run('INSERT INTO sso_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)', auth.sha256(t), m.id, expiresAt);
    const proto = String(ctx.req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const base = PUBLIC_URL || `${proto}://${ctx.req.headers.host}`;
    ctx.status = 201;
    return { url: `${base}/api/auth/sso?token=${t}`, expiresAt: new Date(expiresAt).toISOString() };
  });

  r.get('/api/v1/loans', { ...P, summary: 'Loans (status=active|returned|overdue)' }, (ctx) => {
    const status = v.oneOf(ctx.query.get('status'), 'status', ['active', 'returned', 'overdue'], 'active');
    const t = new Date().toISOString();
    return all(`SELECT l.id, l.status, l.borrowed_at AS borrowedAt, l.due_at AS dueAt, l.returned_at AS returnedAt,
        l.book_id AS bookId, b.title, l.user_id AS memberId, u.external_id AS memberExternalId
      FROM loans l JOIN books b ON b.id=l.book_id JOIN users u ON u.id=l.user_id
      WHERE l.tenant_id=? AND ${status === 'overdue' ? "l.status='active' AND l.due_at<?" : 'l.status=?'} ORDER BY l.borrowed_at DESC LIMIT 500`,
    ctx.tenant.id, status === 'overdue' ? t : status);
  });

  r.post('/api/v1/loans/:id/checkin', { ...P, summary: 'Check in a returned copy (e.g. from a drop-box scanner)' }, (ctx) =>
    lib.returnLoan(ctx.tenant.id, ctx.params.id, partnerActor(ctx)));

  r.get('/api/v1/stats', { ...P, summary: 'Usage KPIs for partner reporting' }, (ctx) => stats(ctx.tenant.id));
};
