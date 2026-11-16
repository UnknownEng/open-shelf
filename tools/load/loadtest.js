// 500 virtual users. Usage: node loadtest.js <baseUrl> <mode: full|read> [users]
'use strict';
const BASE = process.argv[2];
const MODE = process.argv[3] || 'read';
const USERS = Number(process.argv[4] || 500);
const lat = {};
const codes = {};
let errors = 0;

async function hit(name, path, opts = {}) {
  const t = performance.now();
  try {
    const res = await fetch(BASE + path, { ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
    const body = await res.text();
    (lat[name] ||= []).push(performance.now() - t);
    codes[`${name} ${res.status}`] = (codes[`${name} ${res.status}`] || 0) + 1;
    return { res, body };
  } catch (e) { errors++; (lat[name] ||= []).push(performance.now() - t); codes[`${name} ERR`] = (codes[`${name} ERR`] || 0) + 1; return null; }
}

async function user(i) {
  await new Promise((r) => setTimeout(r, Math.random() * 3000)); // ramp up over 3s
  await hit('GET /', '/');
  await hit('GET app.css', '/css/app.css');
  const list = await hit('GET /api/books', '/api/books?sort=popular&limit=60');
  let books = [];
  try { books = JSON.parse(list.body).items; } catch { /* ignore */ }
  const pick = books[Math.floor(Math.random() * books.length)];
  if (pick) await hit('GET /api/books/:id', `/api/books/${pick.id}`);
  if (MODE !== 'full') return;
  const email = `load${Date.now()}${i}${Math.random().toString(36).slice(2, 6)}@example.com`;
  const reg = await hit('POST register', '/api/auth/register', { method: 'POST', body: JSON.stringify({ name: `Load User ${i}`, email, city: 'Lahore', password: 'load-test-password-1' }) });
  const cookie = reg?.res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) return;
  const avail = books.filter((b) => b.available > 0);
  const target = avail[Math.floor(Math.random() * avail.length)] || pick;
  if (!target) return;
  const borrow = await hit('POST borrow', '/api/loans', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ bookId: target.id }) });
  if (borrow?.res.status === 201) {
    const { loanId } = JSON.parse(borrow.body);
    await hit('GET shelf', '/api/me/shelf', { headers: { Cookie: cookie } });
    await hit('POST return', `/api/loans/${loanId}/return`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
  }
}

(async () => {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
  const secs = (performance.now() - t0) / 1000;
  const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(0);
  const total = Object.values(lat).reduce((n, a) => n + a.length, 0);
  console.log(`${USERS} users, mode=${MODE}, ${total} requests in ${secs.toFixed(1)}s (${(total / secs).toFixed(0)} req/s), network errors: ${errors}`);
  console.log('endpoint'.padEnd(22), 'n'.padStart(5), 'p50ms'.padStart(7), 'p95ms'.padStart(7), 'p99ms'.padStart(7), 'maxms'.padStart(7));
  for (const [k, a] of Object.entries(lat)) console.log(k.padEnd(22), String(a.length).padStart(5), pct(a, .5).padStart(7), pct(a, .95).padStart(7), pct(a, .99).padStart(7), Math.max(...a).toFixed(0).padStart(7));
  console.log('status codes:', JSON.stringify(codes));
})();
