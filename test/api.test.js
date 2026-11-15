'use strict';
// End-to-end API tests: boots a real server on a temp database.  Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(os.tmpdir(), `openshelf-test-${process.pid}.sqlite`);
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, DB_PATH: DB, PORT: String(PORT), LOG: '0', JOB_INTERVAL_MS: '600000', RATE_LIMIT_SCALE: '50' };
let server;

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get: (u, h) => call('GET', u, undefined, h), post: (u, b = {}, h) => call('POST', u, b, h), patch: (u, b, h) => call('PATCH', u, b, h), del: (u, h) => call('DELETE', u, undefined, h) };
}

const pw = 'correct-horse-battery';
async function member(name) {
  const c = client();
  const email = `${name.toLowerCase().replace(/\W+/g, '')}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const r = await c.post('/api/auth/register', { name, email, city: 'Lahore', password: pw });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.email = email;
  c.user = r.data.user;
  return c;
}

before(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'inherit'] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* locked on Windows */ } }
});

test('health, catalogue and OpenAPI are public', async () => {
  const c = client();
  assert.equal((await c.get('/api/health')).data.ok, true);
  const books = await c.get('/api/books?sort=title&limit=5');
  assert.equal(books.status, 200);
  assert.equal(books.data.items.length, 5);
  assert.ok(books.data.total >= 20);
  const spec = await c.get('/api/openapi.json');
  assert.ok(Object.keys(spec.data.paths).length > 40);
});

test('registration validates input and rejects duplicates', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/register', { name: 'A', email: 'bad', city: 'X', password: 'short' })).status, 400);
  const m = await member('Dup');
  assert.equal((await client().post('/api/auth/register', { name: 'Dup Two', email: m.email, city: 'Lahore', password: pw })).status, 409);
  assert.equal(m.user.credits, 3);
});

test('login: wrong password fails, right password sets a session', async () => {
  const m = await member('Login');
  const c = client();
  assert.equal((await c.post('/api/auth/login', { email: m.email, password: 'wrong-password!!' })).status, 401);
  const ok = await c.post('/api/auth/login', { email: m.email, password: pw });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await c.get('/api/me')).data.user.email, m.email);
});

test('borrow uses a credit, return gives it back, ledger records both', async () => {
  const m = await member('Borrower');
  const loan = await m.post('/api/loans', { bookId: 'b2' });
  assert.equal(loan.status, 201);
  assert.equal(loan.data.credits, 2);
  assert.equal((await m.post('/api/loans', { bookId: 'b2' })).status, 409, 'cannot borrow same book twice');
  const shelf = await m.get('/api/me/shelf');
  assert.equal(shelf.data.active.length, 1);
  const ret = await m.post(`/api/loans/${loan.data.loanId}/return`);
  assert.equal(ret.data.credits, 3);
  const ledger = (await m.get('/api/credits')).data.map((x) => x.reason);
  assert.deepEqual(ledger.sort(), ['borrow', 'return', 'welcome']);
});

test('no credits → 402; members cannot return other members\' loans', async () => {
  const a = await member('Spender');
  for (const id of ['b10', 'b13', 'b17']) assert.equal((await a.post('/api/loans', { bookId: id })).status, 201);
  const r = await a.post('/api/loans', { bookId: 'b4' });
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'no_credits');
  const b = await member('Intruder');
  const loanId = (await a.get('/api/me/shelf')).data.active[0].id;
  assert.equal((await b.post(`/api/loans/${loanId}/return`)).status, 404);
});

test('waitlist: unavailable book → reserve → return promotes hold → holder borrows', async () => {
  const owner = await member('Holder');
  const waiter = await member('Waiter');
  const other = await member('Other');
  assert.equal((await owner.post('/api/loans', { bookId: 'b6' })).status, 201); // b6 has 1 copy
  const blocked = await waiter.post('/api/loans', { bookId: 'b6' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'unavailable');
  const res = await waiter.post('/api/reservations', { bookId: 'b6' });
  assert.equal(res.status, 201);
  assert.equal(res.data.position, 1);
  // Renewal is blocked while someone waits.
  const loanId = (await owner.get('/api/me/shelf')).data.active[0].id;
  assert.equal((await owner.post(`/api/loans/${loanId}/renew`)).status, 409);
  await owner.post(`/api/loans/${loanId}/return`);
  // The freed copy is held for the waiter, not for anyone else.
  assert.equal((await other.post('/api/loans', { bookId: 'b6' })).status, 409);
  const ready = (await waiter.get('/api/me/shelf')).data.reservations[0];
  assert.equal(ready.status, 'ready');
  assert.equal((await waiter.post('/api/loans', { bookId: 'b6' })).status, 201);
  assert.equal((await waiter.get('/api/me/shelf')).data.reservations.length, 0);
  const notes = (await waiter.get('/api/notifications')).data.map((n) => n.kind);
  assert.ok(notes.includes('reservation'));
});

test('renew extends once when nobody is waiting', async () => {
  const m = await member('Renewer');
  const loan = (await m.post('/api/loans', { bookId: 'b5' })).data;
  const r = await m.post(`/api/loans/${loan.loanId}/renew`);
  assert.equal(r.status, 200);
  assert.ok(new Date(r.data.dueAt) > new Date(loan.dueAt));
  assert.equal((await m.post(`/api/loans/${loan.loanId}/renew`)).status, 409);
});

test('reviews require having borrowed the book', async () => {
  const m = await member('Critic');
  assert.equal((await m.post('/api/books/b9/reviews', { rating: 5, body: 'Great' })).status, 403);
  await m.post('/api/loans', { bookId: 'b9' });
  const r = await m.post('/api/books/b9/reviews', { rating: 4, body: 'Great' });
  assert.equal(r.status, 201);
  assert.equal(r.data.reviewCount >= 1, true);
});

test('cross-site writes are rejected; unauthenticated writes get 401', async () => {
  const m = await member('Csrf');
  assert.equal((await m.post('/api/loans', { bookId: 'b1' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await client().post('/api/loans', { bookId: 'b1' })).status, 401);
  assert.equal((await m.call('POST', '/api/loans', undefined, { 'Content-Type': 'text/plain' })).status, 415);
});

test('admin console is staff-only; staff can manage catalogue, members and keys', async () => {
  const staff = await member('Staff');
  assert.equal((await staff.get('/api/admin/stats')).status, 403);
  execFileSync(process.execPath, ['server/index.js', 'make-admin', staff.email], { cwd: ROOT, env: ENV });
  const stats = await staff.get('/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.data.loansPerDay.length, 30);

  const book = await staff.post('/api/admin/books', { title: 'Test Driven Reading', author: 'Q. A. Tester', totalCopies: 2, isbn: '978-0-00-000000-2' });
  assert.equal(book.status, 201);
  assert.equal(book.data.totalCopies, 2);
  assert.equal((await staff.patch(`/api/admin/books/${book.data.id}`, { archived: true })).data.archived, true);
  assert.equal((await client().get(`/api/books/${book.data.id}`)).status, 404, 'archived titles are hidden');

  const target = await member('Target');
  assert.equal((await staff.patch(`/api/admin/members/${target.user.id}`, { creditDelta: 5, reason: 'gift' })).status, 200);
  assert.equal((await target.get('/api/me')).data.user.credits, 8);
  await staff.patch(`/api/admin/members/${target.user.id}`, { status: 'suspended' });
  assert.equal((await target.get('/api/me')).data.user, null, 'suspended member is signed out');
  assert.equal((await staff.patch(`/api/admin/members/${target.user.id}`, { role: 'owner' })).status, 400, 'admins cannot mint owners');

  const audit = await staff.get('/api/admin/audit');
  assert.ok(audit.data.some((a) => a.action === 'member.suspended'));
});

test('partner API: keys, provisioning, credit grants, SSO hand-off and signed webhooks', async () => {
  const staff = await member('Partner Admin');
  execFileSync(process.execPath, ['server/index.js', 'make-admin', staff.email], { cwd: ROOT, env: ENV });

  // Local receiver for webhooks.
  const received = [];
  const hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.end('ok'); });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  const hook = await staff.post('/api/admin/webhooks', { url: `http://localhost:${hookServer.address().port}/hook`, events: '*' });
  assert.equal(hook.status, 201);

  const key = (await staff.post('/api/admin/api-keys', { name: 'Test integration' })).data.key;
  const auth = { Authorization: `Bearer ${key}` };
  const p = client();
  assert.equal((await p.get('/api/v1/books')).status, 401);
  assert.equal((await p.get('/api/v1/books', auth)).status, 200);

  const mem = await p.post('/api/v1/members', { name: 'Sso User', email: `sso-${Date.now()}@uni.example`, externalId: `stu_${Date.now()}`, credits: 0 }, auth);
  assert.equal(mem.status, 201);
  assert.equal(mem.data.credits, 0);
  const grant = await p.post(`/api/v1/members/${mem.data.externalId}/credits`, { delta: 4 }, auth);
  assert.equal(grant.data.credits, 4);
  const imported = await p.post('/api/v1/books', { books: [{ title: 'Bulk One', author: 'Importer' }, { title: 'Bulk Two', author: 'Importer', totalCopies: 3 }] }, auth);
  assert.equal(imported.data.created, 2);

  const link = await p.post(`/api/v1/members/${mem.data.id}/login-link`, {}, auth);
  assert.equal(link.status, 201);
  const sso = client();
  const redeem = await sso.get(new URL(link.data.url).pathname + new URL(link.data.url).search);
  assert.equal(redeem.status, 302);
  assert.equal(redeem.headers.get('location'), '/#/shelf');
  assert.equal((await sso.get('/api/me')).data.user.credits, 4);
  assert.equal((await client().get(new URL(link.data.url).pathname + new URL(link.data.url).search)).headers.get('location'), '/#/?sso=expired', 'links are single-use');

  // Borrow via SSO session → loan.created webhook, signed with the secret.
  assert.equal((await sso.post('/api/loans', { bookId: 'b8' })).status, 201);
  for (let i = 0; i < 40 && !received.some((r) => r.headers['x-openshelf-event'] === 'loan.created'); i++) await new Promise((r) => setTimeout(r, 50));
  const ev = received.find((r) => r.headers['x-openshelf-event'] === 'loan.created');
  assert.ok(ev, 'webhook delivered');
  const expected = `sha256=${crypto.createHmac('sha256', hook.data.secret).update(ev.body).digest('hex')}`;
  assert.equal(ev.headers['x-openshelf-signature'], expected);
  assert.equal(JSON.parse(ev.body).data.bookId, 'b8');

  const loans = await p.get('/api/v1/loans?status=active', auth);
  assert.ok(loans.data.some((l) => l.memberExternalId === mem.data.externalId));

  // Revoked keys stop working.
  const keys = (await staff.get('/api/admin/api-keys')).data;
  await staff.del(`/api/admin/api-keys/${keys[0].id}`);
  assert.equal((await p.get('/api/v1/books', auth)).status, 401);
  hookServer.close();
});
