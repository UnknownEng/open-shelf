'use strict';
/**
 * Open Shelf: end-to-end browser QA suite (real Chrome via playwright-core).
 *
 *   node --test media/evaluation/qa/e2e.test.js
 *
 * Boots its own server on a fresh demo database (port 3207 by default), drives the
 * member site, the staff console at /admin and the partner API, and writes a
 * screenshot named FAIL-<test>.png into this folder for every failing test.
 *
 * Env: QA_PORT (default 3207), PLAYWRIGHT_CORE (path to playwright-core),
 *      QA_EXTERNAL=1 to reuse an already running server instead of spawning one.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Browser end-to-end suite. Needs Google Chrome and playwright-core:
//   npm i --no-save playwright-core && npm run test:e2e
// (or set PLAYWRIGHT_CORE to the path of an existing playwright-core install)
const PW_PATH = process.env.PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(PW_PATH);

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'media', 'evaluation', 'qa');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.QA_PORT || 3207);
const BASE = `http://localhost:${PORT}`;
const DB = path.join(process.env.TEMP || os.tmpdir(), 'os-qa.sqlite');
const ADMIN = { email: 'admin@openshelf.test', password: 'DemoAdmin!2026' };
const READER = { email: 'reader@openshelf.test', password: 'DemoReader!2026' };
const RUN = crypto.randomBytes(3).toString('hex');
const T = Number(process.env.QA_TIMEOUT || 15_000);

// Shared state between (sequential) tests.
const S = {
  member: { name: 'QA Tester', city: 'Lahore', email: `qa.tester.${RUN}@example.com`, password: 'QaTesterPass!2026', newPassword: 'QaNewPassw0rd!2026' },
  books: {},
  apiKey: null,
};

let server, browser, hookServer;
const hooks = []; // webhook deliveries received by the local receiver
const pageErrors = [];
const tracked = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- node-side API client (cookie jar)
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    call, get: (u, h) => call('GET', u, undefined, h), post: (u, b = {}, h) => call('POST', u, b, h),
    patch: (u, b, h) => call('PATCH', u, b, h), del: (u, h) => call('DELETE', u, undefined, h),
    async login(creds) { const r = await call('POST', '/api/auth/login', creds); assert.equal(r.status, 200, `login ${creds.email}: ${JSON.stringify(r.data)}`); return r; },
  };
}
const admin = client();
const holder = client();   // member who keeps the single copies of the waitlist/hold books out
const target = client();   // member that the staff console acts on

// ---------------------------------------------------------------- browser helpers
async function newPage({ viewport = { width: 1280, height: 860 }, login, ...ctxOpts } = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport, acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  page.setDefaultNavigationTimeout(3 * T);
  // Cover images and fonts come from third-party hosts; do not let a slow CDN hold up the
  // window "load" event; every assertion waits for the element it needs instead.
  const goto = page.goto.bind(page), reload = page.reload.bind(page);
  page.goto = (u, o = {}) => goto(u, { waitUntil: 'domcontentloaded', ...o });
  page.reload = (o = {}) => reload({ waitUntil: 'domcontentloaded', ...o });
  page.on('pageerror', (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
  tracked.add(page);
  if (login) {
    const r = await ctx.request.post('/api/auth/login', { data: login });
    assert.equal(r.status(), 200, `browser login ${login.email} -> ${r.status()} ${await r.text()}`);
  }
  return page;
}

function qa(name, fn) {
  test(name, async () => {
    tracked.clear();
    try {
      await fn();
    } catch (err) {
      const slug = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
      let i = 0;
      for (const p of tracked) {
        if (p.isClosed()) continue;
        const file = path.join(OUT, `FAIL-${slug}${i ? `-${i}` : ''}.png`);
        try { await p.screenshot({ path: file }); err.message += `\n    screenshot: ${file}`; } catch { /* page gone */ }
        i++;
      }
      throw err;
    } finally {
      for (const p of tracked) await p.context().close().catch(() => {});
      tracked.clear();
    }
  });
}

async function poll(get, ok, what, timeout = T) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await get(); if (ok(last)) return last; } catch (e) { last = `ERR ${e.message.split('\n')[0]}`; }
    if (Date.now() > end) throw new assert.AssertionError({ message: `Timed out waiting for ${what}. Last value: ${JSON.stringify(last)}` });
    await sleep(120);
  }
}
const textOf = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim());
const waitText = (loc, re, what) => poll(() => textOf(loc), (t) => re.test(t), what || `text ${re}`);
async function toast(page, re) {
  try { await page.locator('#toasts .toast', { hasText: re }).first().waitFor({ state: 'attached', timeout: T }); } catch {
    const all = await page.locator('#toasts .toast').allInnerTexts().catch(() => []);
    throw new assert.AssertionError({ message: `Expected toast ${re}, saw: ${JSON.stringify(all)}` });
  }
}
const apiJson = async (page, url) => (await page.request.get(url)).json();
const modalOpen = (page) => page.locator('.modal.open').last();
// After borrowing, a "Go get your book" sheet explains pickup; close it to continue.
async function dismissNextStep(page) {
  const ns = page.locator('.modal.open', { hasText: 'Go get your' });
  await ns.waitFor({ timeout: T });
  await ns.locator('.modal-close').click();
  await ns.waitFor({ state: 'detached', timeout: T });
}
// Returning a book / leaving a waitlist now asks for confirmation.
async function confirmYes(page) {
  const yes = page.locator('.modal.open [data-yes]').last();
  await yes.waitFor({ timeout: T });
  await yes.click();
}
async function credits(page) { return Number(await page.locator('#creditCount').innerText()); }

async function openBookFromBrowse(page, id) {
  if (!page.url().includes('#/browse')) await page.goto('/#/browse');
  const card = page.locator(`.book-card[data-id="${id}"]`);
  await card.waitFor();
  await card.locator('.cover').click();
  const m = modalOpen(page);
  await m.locator('.detail h2').waitFor();
  return m;
}

// ---------------------------------------------------------------- setup / teardown
before(async () => {
  for (const f of fs.readdirSync(OUT)) if (/^FAIL-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
  if (!process.env.QA_EXTERNAL) {
    let busy = false;
    try { busy = (await fetch(`${BASE}/api/health`)).ok; } catch { /* free */ }
    if (busy) throw new Error(`Port ${PORT} already serves something; stop it or set QA_EXTERNAL=1`);
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
    const env = { ...process.env, DB_PATH: DB, PORT: String(PORT), LOG: '0', RATE_LIMIT_SCALE: '50' };
    execFileSync(process.execPath, ['server/demo.js'], { cwd: ROOT, env, stdio: 'ignore' });
    server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
    await poll(() => fetch(`${BASE}/api/health`).then((r) => r.ok), Boolean, 'server health', 20_000);
  }

  // Local webhook receiver.
  hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hooks.push({ headers: req.headers, body }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));

  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // Deterministic fixtures created through the real admin API.
  await admin.login(ADMIN);
  const mk = async (key, title, copies) => {
    const r = await admin.post('/api/admin/books', { title, author: 'QA Author', category: 'QA Testing', condition: 'Good', totalCopies: copies, description: `${title} fixture` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    S.books[key] = { id: r.data.id, title };
  };
  await mk('lend', 'QA Lending Primer', 3);
  await mk('extra', 'QA Second Copy', 2);
  await mk('wait', 'QA Waitlist Novel', 1);
  await mk('hold', 'QA Hold Novel', 1);

  const reg = async (c, name) => {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${RUN}@example.com`;
    const r = await c.post('/api/auth/register', { name, email, city: 'Multan', password: 'QaFixturePass!1' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...r.data.user, password: 'QaFixturePass!1' };
  };
  S.holder = await reg(holder, 'QA Holder');
  S.target = await reg(target, 'QA Target');
  for (const k of ['wait', 'hold']) {
    const r = await holder.post('/api/loans', { bookId: S.books[k].id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    S.books[k].holderLoan = r.data.loanId;
  }
});

after(async () => {
  await browser?.close().catch(() => {});
  hookServer?.close();
  if (server) {
    server.kill();
    await sleep(500);
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* locked on Windows */ } }
  }
});

// =================================================================== HOME
qa('01 home: hero, tickers, stats count up, marquee cover opens book modal', async () => {
  const page = await newPage();
  // Record every value the hero stat counters display, to prove they count up.
  await page.addInitScript(() => {
    window.__qaCounts = [];
    new MutationObserver(() => {
      const v = [...document.querySelectorAll('.hero-stats b[data-count]')].map((b) => b.textContent);
      if (v.length) window.__qaCounts.push(v.join(','));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const stats = await (await fetch(`${BASE}/api/stats/public`)).json();
  await page.goto('/#/');
  await waitText(page.locator('#heroTitle'), /Read it\.\s*Pass it\.\s*Repeat\./, 'hero title');
  assert.equal(await page.locator('.ticker').count(), 2, 'two tickers');
  for (const t of await page.locator('.ticker').all()) assert.ok(await t.locator('.ticker-track span').count() > 4, 'ticker has items');
  const nums = page.locator('.hero-stats b[data-count]');
  assert.equal(await nums.count(), 3);
  const expected = [stats.titles, stats.members, stats.loans];
  assert.ok(expected.every((n) => n > 0), `public stats should be >0: ${JSON.stringify(stats)}`);
  for (let i = 0; i < 3; i++) {
    assert.equal(Number(await nums.nth(i).getAttribute('data-count')), expected[i], `stat ${i} target matches API`);
    await waitText(nums.nth(i), new RegExp(`^${expected[i]}$`), `stat ${i} counts up to ${expected[i]}`);
  }
  const seen = await page.evaluate(() => window.__qaCounts);
  assert.equal(seen[0], '0,0,0', `counters start at 0 (saw ${seen.slice(0, 3)})`);
  const mid = seen.filter((v) => v.split(',').some((x, i) => Number(x) > 0 && Number(x) < expected[i]));
  assert.ok(mid.length >= 3, `counters pass through intermediate values (${seen.length} frames)`);

  const btn = page.locator('.marquee button[data-book]').first();
  const title = await btn.getAttribute('aria-label');
  await btn.click({ force: true }); // the marquee scrolls forever, so it never becomes "stable"
  const m = modalOpen(page);
  await waitText(m.locator('.detail h2'), new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'modal title = clicked cover');
  await page.keyboard.press('Escape');
  await page.locator('.modal.open').waitFor({ state: 'detached' });
});

// =================================================================== BROWSE
qa('02 browse: search filters results by author', async () => {
  const page = await newPage();
  await page.goto('/#/browse');
  await page.locator('.book-card').first().waitFor();
  const api = await (await fetch(`${BASE}/api/books?q=mohsin%20hamid&limit=200`)).json();
  assert.ok(api.total >= 1);
  await page.fill('#q', 'Mohsin Hamid');
  await waitText(page.locator('#count'), new RegExp(`^${api.total} books?$`), 'result count');
  const authors = await page.locator('.book-card .by').allInnerTexts();
  assert.equal(authors.length, api.total);
  assert.ok(authors.every((a) => /Mohsin Hamid/.test(a)), `all results by Mohsin Hamid: ${authors}`);
});

qa('03 browse: genre chip filters to that genre', async () => {
  const page = await newPage();
  await page.goto('/#/browse');
  const chip = page.locator('#chips [data-cat="QA Testing"]');
  await chip.waitFor();
  assert.match(await chip.innerText(), /QA Testing\s*4/);
  await chip.click();
  await poll(() => chip.getAttribute('class'), (c) => /active/.test(c), 'chip active');
  await waitText(page.locator('#count'), /^4 books$/);
  const titles = await page.locator('.book-card h3').allInnerTexts();
  assert.deepEqual(titles.sort(), ['QA Hold Novel', 'QA Lending Primer', 'QA Second Copy', 'QA Waitlist Novel']);
});

qa('04 browse: "Available now" toggle hides books with no free copy', async () => {
  const page = await newPage();
  await page.goto('/#/browse');
  await page.locator('#chips [data-cat="QA Testing"]').click();
  await waitText(page.locator('#count'), /^4 books$/);
  await page.check('#avail');
  await waitText(page.locator('#count'), /^2 books$/);
  const titles = await page.locator('.book-card h3').allInnerTexts();
  assert.deepEqual(titles.sort(), ['QA Lending Primer', 'QA Second Copy']);
  const tags = await page.locator('.book-card .card-badges').allInnerTexts();
  assert.ok(tags.every((t) => /available/.test(t)), `tags: ${tags}`);
  await page.uncheck('#avail');
  await waitText(page.locator('#count'), /^4 books$/);
});

qa('05 browse: sort A-Z and Top rated reorder the grid', async () => {
  const page = await newPage();
  await page.goto('/#/browse');
  await page.locator('.book-card').first().waitFor();
  await page.selectOption('#sort', 'title');
  await poll(async () => (await page.locator('.book-card h3').allInnerTexts()), (t) => t.length > 5 && t.every((x, i) => !i || t[i - 1].toLowerCase() <= x.toLowerCase()), 'A-Z order');
  await page.selectOption('#sort', 'rating');
  const ratings = await poll(async () => page.locator('.book-card .card-foot').evaluateAll((els) => els.map((e) => { const s = e.querySelector('.stars'); return s ? parseFloat(s.getAttribute('aria-label')) : -1; })),
    (r) => r.length > 5 && r.every((x, i) => !i || r[i - 1] >= x) && r[0] > 0, 'rating order (desc, unrated last)');
  assert.ok(ratings[0] >= ratings[ratings.length - 1]);
});

qa('06 browse: empty state and "Clear filters"', async () => {
  const page = await newPage();
  await page.goto('/#/browse');
  await page.locator('.book-card').first().waitFor();
  const all = await textOf(page.locator('#count'));
  await page.locator('#chips [data-cat="QA Testing"]').click();
  await page.check('#avail');
  await page.fill('#q', 'zzqx-no-such-book');
  await waitText(page.locator('#grid .empty h3'), /No books match/);
  await waitText(page.locator('#count'), /^0 books$/);
  await page.click('#clear');
  await waitText(page.locator('#count'), new RegExp(`^${all}$`), 'count restored');
  assert.equal(await page.inputValue('#q'), '');
  assert.equal(await page.isChecked('#avail'), false);
  assert.match(await page.locator('#chips .chip.active').innerText(), /^All/);
});

// =================================================================== AUTH
qa('07 register: validation errors, weak password, success shows credits in header', async () => {
  const page = await newPage();
  const u = S.member;
  await page.goto('/#/');
  await page.click('#joinBtn');
  const m = modalOpen(page);
  const err = m.locator('#authError');
  const submit = () => m.locator('#authSubmit').click();
  // All missing fields are listed in one message (usability study: one-at-a-time errors cost users 3 rounds).
  await submit();
  await waitText(err, /your full name, your city, a valid email address and a password of at least 10 characters/);
  await m.locator('[name=name]').fill(u.name);
  await m.locator('[name=email]').fill('not-an-email');
  await submit();
  await waitText(err, /Please add your city, a valid email address and a password/);
  await m.locator('[name=email]').fill(u.email);
  await m.locator('[name=city]').fill(u.city);
  await m.locator('[name=password]').fill('short');
  assert.equal(await m.locator('.pw-meter i').evaluate((e) => e.style.getPropertyValue('--p')), '0%', 'weak meter');
  await submit();
  await waitText(err, /Please add a password of at least 10 characters/);
  await m.locator('[name=password]').fill(u.password);
  assert.equal(await m.locator('.pw-meter i').evaluate((e) => e.style.getPropertyValue('--p')), '100%', 'strong meter');
  await submit();
  await toast(page, /3 credits are ready/);
  await page.locator('.modal.open').waitFor({ state: 'detached' });
  await page.locator('#creditPill').waitFor({ state: 'visible' });
  assert.equal(await credits(page), 3);
  assert.equal(await page.locator('#avatarBtn').innerText(), 'QT');
  assert.equal(await page.locator('#signInBtn').isVisible(), false);

  // Duplicate email is rejected.
  await page.click('#avatarBtn');
  await page.click('#signOut');
  await page.locator('#joinBtn').waitFor({ state: 'visible' });
  await page.click('#joinBtn');
  const m2 = modalOpen(page);
  await m2.locator('[name=name]').fill(u.name);
  await m2.locator('[name=city]').fill(u.city);
  await m2.locator('[name=email]').fill(u.email);
  await m2.locator('[name=password]').fill(u.password);
  await m2.locator('#authSubmit').click();
  await waitText(m2.locator('#authError'), /already exists/);
});

qa('08 sign in / sign out / wrong password', async () => {
  const page = await newPage({ login: { email: S.member.email, password: S.member.password } });
  await page.goto('/#/');
  await page.locator('#avatarBtn').waitFor({ state: 'visible' });
  await page.click('#avatarBtn');
  await page.click('#signOut');
  await toast(page, /Signed out/);
  await page.locator('#signInBtn').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#creditPill').isVisible(), false);
  assert.equal((await apiJson(page, '/api/me')).user, null);

  await page.click('#signInBtn');
  const m = modalOpen(page);
  await m.locator('[name=email]').fill(S.member.email);
  await m.locator('[name=password]').fill('WrongPassword!!');
  await m.locator('#authSubmit').click();
  await waitText(m.locator('#authError'), /Email or password is incorrect/);
  await m.locator('[name=password]').fill(S.member.password);
  await m.locator('#authSubmit').click();
  await toast(page, /Welcome back, QA!/);
  await page.locator('#avatarBtn').waitFor({ state: 'visible' });
  assert.equal(await credits(page), 3);
});

// =================================================================== BOOK MODAL + CREDITS
qa('09 book modal: copies bar, borrow (-1 credit), review stars, renew, return (+1 credit)', async () => {
  const page = await newPage({ login: { email: S.member.email, password: S.member.password } });
  const b = S.books.lend;
  await page.goto('/#/browse');
  const m = await openBookFromBrowse(page, b.id);
  await waitText(m.locator('.copies span').first(), /^3 of 3 available$/);
  assert.equal(await m.locator('.copies-bar i').count(), 3);
  assert.equal(await m.locator('.copies-bar i.out').count(), 0);
  assert.match(await textOf(m.locator('.reviews')), /No reviews yet/);
  assert.equal(await m.locator('#reviewForm').count(), 0, 'cannot review before borrowing');
  assert.equal(await credits(page), 3);

  await m.locator('[data-act=borrow]').click();
  await toast(page, /Borrowed! Due back/);
  await dismissNextStep(page);
  await poll(() => credits(page), (c) => c === 2, 'header credits 3 -> 2');
  await waitText(m.locator('.copies span').first(), /^2 of 3 available$/);
  assert.equal(await m.locator('.copies-bar i.out').count(), 1);
  await m.locator('[data-act=return]').waitFor();
  const ledger = await apiJson(page, '/api/credits');
  assert.deepEqual([ledger[0].delta, ledger[0].reason], [-1, 'borrow']);

  // Review: star validation, then a 4-star review.
  await m.locator('#reviewForm').waitFor();
  await m.locator('#reviewForm button').click();
  await toast(page, /Pick a star rating first/);
  await m.locator('label[for=r4]').click();
  await m.locator('#reviewForm textarea').fill('QA review: crisp and clear.');
  await m.locator('#reviewForm button').click();
  await toast(page, /Thanks for your review/);
  await waitText(m.locator('.reviews .review').first(), /QA.*QA review: crisp and clear\./);
  await waitText(m.locator('.detail-tags'), /★ 4 · 1/);

  // Renew once, then the second renewal is refused.
  await m.locator('[data-act=renew]').click();
  await toast(page, /Renewed — new due date/);
  await waitText(m.locator('.detail-actions'), /due in 35 days/);
  await page.waitForTimeout(1000); // deliberate second tap (fast double-taps are ignored by design)
  await m.locator('[data-act=renew]').click();
  await toast(page, /already been renewed/);

  await page.waitForTimeout(1000);
  await m.locator('[data-act=return]').click();
  await confirmYes(page);
  await toast(page, /Returned — your credit is back/);
  await poll(() => credits(page), (c) => c === 3, 'header credits 2 -> 3');
  await m.locator('[data-act=borrow]').waitFor();
  await waitText(m.locator('.copies span').first(), /^3 of 3 available$/);
});

qa('10 book modal: join waitlist when 0 available, then leave it', async () => {
  const page = await newPage({ login: { email: S.member.email, password: S.member.password } });
  const m = await openBookFromBrowse(page, S.books.wait.id);
  await waitText(m.locator('.copies span').first(), /^0 of 1 available$/);
  assert.equal(await m.locator('.copies-bar i.out').count(), 1);
  assert.equal(await m.locator('[data-act=borrow]').count(), 0, 'no borrow button when nothing is free');
  assert.match(await textOf(m.locator('.detail-actions')), /All 1 copy is out/);
  await m.locator('[data-act=reserve]').click();
  await toast(page, /You're #1 on the waitlist/);
  await m.locator('[data-act=cancel]').waitFor();
  await waitText(m.locator('.detail-actions'), /You're #1 in line/);
  await page.waitForTimeout(1000); // a double-tap must NOT leave the waitlist; a deliberate tap may
  await m.locator('[data-act=cancel]').click();
  await confirmYes(page);
  await toast(page, /Removed from the waitlist/);
  await m.locator('[data-act=reserve]').waitFor();
  assert.equal(await credits(page), 3, 'waitlist does not cost credits');
});

// =================================================================== SHELF
qa('11 shelf: due rings, renew, return, history, credit ledger, ready hold -> Borrow now', async () => {
  const page = await newPage({ login: { email: S.member.email, password: S.member.password } });
  for (const k of ['lend', 'extra']) {
    const r = await page.request.post('/api/loans', { data: { bookId: S.books[k].id } });
    assert.equal(r.status(), 201, await r.text());
  }
  assert.equal((await page.request.post('/api/reservations', { data: { bookId: S.books.hold.id } })).status(), 201);
  await page.goto('/#/shelf');
  const onShelf = page.locator('.shelf-section').filter({ has: page.locator('h2', { hasText: 'On your shelf' }) });
  await onShelf.locator('.loan').first().waitFor();
  assert.equal(await onShelf.locator('.loan').count(), 2);
  assert.equal(await credits(page), 1);
  const lendCard = onShelf.locator('.loan', { hasText: 'QA Lending Primer' });
  assert.equal(await lendCard.locator('.ring-prog b').innerText(), '21');
  assert.match(await lendCard.locator('.ring-prog small').innerText(), /days left/);
  await poll(() => lendCard.locator('.ring-prog .fg').evaluate((c) => c.style.strokeDashoffset), (v) => v !== '' && Number(v) < 5, 'ring animated to full');
  const waitSec = page.locator('.shelf-section').filter({ has: page.locator('h2', { hasText: 'Waitlist' }) });
  await waitText(waitSec, /QA Hold Novel.*#1 in line/);

  await lendCard.locator('[data-renew]').click();
  await toast(page, /Renewed/);
  await waitText(onShelf.locator('.loan', { hasText: 'QA Lending Primer' }), /renewed/);
  assert.equal(await onShelf.locator('.loan', { hasText: 'QA Lending Primer' }).locator('.ring-prog b').innerText(), '35');
  assert.equal(await onShelf.locator('.loan', { hasText: 'QA Lending Primer' }).locator('[data-renew]').count(), 0, 'no second renew button');

  await onShelf.locator('.loan', { hasText: 'QA Second Copy' }).locator('[data-return]').click();
  await confirmYes(page);
  await toast(page, /Returned/);
  await poll(() => credits(page), (c) => c === 2, 'credits 1 -> 2 after return');
  await poll(() => onShelf.locator('.loan').count(), (n) => n === 1, 'one loan left');
  const hist = page.locator('.shelf-section').filter({ has: page.locator('h2', { hasText: 'Reading history' }) });
  assert.ok(await hist.locator('.history > div').count() >= 2, 'history lists returned books');
  const ledger = await page.locator('.ledger .ledger-row').allInnerTexts();
  const flat = ledger.map((t) => t.replace(/\s+/g, ' '));
  assert.match(flat[0], /Returned a book.*\+1/);
  assert.ok(flat.some((t) => /Borrowed a book.*-1/.test(t)), 'borrow row');
  assert.ok(flat.some((t) => /Welcome credits.*\+3/.test(t)), 'welcome row');
  const sum = flat.reduce((a, t) => a + Number(t.match(/([+-]\d+)$/)[1]), 0);
  assert.equal(sum, 2, 'ledger sums to current balance');

  // The copy the holder had comes back -> hold becomes ready.
  const r = await holder.post(`/api/loans/${S.books.hold.holderLoan}/return`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await page.reload();
  await waitText(waitSec, /QA Hold Novel.*Ready — held until/);
  await waitSec.locator('[data-borrow]').click();
  await toast(page, /Borrowed!/);
  await poll(() => credits(page), (c) => c === 1, 'credits 2 -> 1 after borrowing the hold');
  await waitText(onShelf, /QA Hold Novel/);
  await poll(() => page.locator('.shelf-section h2', { hasText: 'Waitlist' }).count(), (n) => n === 0, 'waitlist section gone');
});

qa('12 notifications bell: badge count, list, mark all read', async () => {
  const page = await newPage({ login: { email: S.member.email, password: S.member.password } });
  await page.goto('/#/');
  const { unread } = await apiJson(page, '/api/me');
  assert.ok(unread >= 5, `expected several unread notifications, got ${unread}`);
  const badge = page.locator('#bellBadge');
  await waitText(badge, new RegExp(`^${unread > 9 ? '9\\+' : unread}$`), 'badge count');
  await page.click('#bellBtn');
  const panel = page.locator('#notifPanel.open');
  await panel.locator('.notif').first().waitFor();
  assert.equal(await panel.locator('.notif.unread').count(), unread);
  assert.match(await textOf(panel), /is ready for you/);
  await panel.locator('#markRead').click();
  await poll(() => badge.isVisible(), (v) => v === false, 'badge hidden');
  await poll(() => panel.locator('.notif.unread').count(), (n) => n === 0, 'no unread rows');
  assert.equal((await apiJson(page, '/api/me')).unread, 0);
  await page.reload();
  await page.locator('#avatarBtn').waitFor({ state: 'visible' });
  assert.equal(await badge.isVisible(), false, 'badge stays hidden after reload');
});

qa('13 shelf: profile edit and password change (old password then fails)', async () => {
  const u = S.member;
  const page = await newPage({ login: { email: u.email, password: u.password } });
  await page.goto('/#/shelf');
  await page.click('#editProfile');
  const m = modalOpen(page);
  await m.locator('#pf [name=name]').fill('QA Renamed');
  await m.locator('#pf [name=city]').fill('Karachi');
  await m.locator('#pf button').click();
  await toast(page, /Profile saved/);
  await waitText(page.locator('#avatarBtn'), /^QR$/);
  const me = (await apiJson(page, '/api/me')).user;
  assert.deepEqual([me.name, me.city], ['QA Renamed', 'Karachi']);

  await m.locator('#pw [name=currentPassword]').fill('not-my-password');
  await m.locator('#pw [name=newPassword]').fill(u.newPassword);
  await m.locator('#pw button').click();
  await waitText(m.locator('#pwErr'), /Current password is incorrect/);
  await m.locator('#pw [name=currentPassword]').fill(u.password);
  await m.locator('#pw button').click();
  await toast(page, /Password changed/);
  assert.ok((await apiJson(page, '/api/me')).user, 'still signed in on this device');

  await page.click('#avatarBtn');
  await page.click('#signOut');
  await page.locator('#signInBtn').waitFor({ state: 'visible' });
  await page.click('#signInBtn');
  const lm = modalOpen(page);
  await lm.locator('[name=email]').fill(u.email);
  await lm.locator('[name=password]').fill(u.password);
  await lm.locator('#authSubmit').click();
  await waitText(lm.locator('#authError'), /Email or password is incorrect/);
  await lm.locator('[name=password]').fill(u.newPassword);
  await lm.locator('#authSubmit').click();
  await toast(page, /Welcome back, QA!/);
  u.password = u.newPassword;
});

// =================================================================== THEME + MOBILE
qa('14 theme toggle persists after reload', async () => {
  const page = await newPage();
  await page.goto('/#/');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.locator('#heroTitle').waitFor();
  assert.equal(await theme(), 'light');
  await page.click('#themeToggle');
  assert.equal(await theme(), 'dark');
  await page.reload();
  await page.locator('#heroTitle').waitFor();
  assert.equal(await theme(), 'dark', 'dark survives reload');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#themeToggle');
  assert.equal(await theme(), 'light');
  await page.reload();
  await page.locator('#heroTitle').waitFor();
  assert.equal(await theme(), 'light', 'light survives reload');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), bg, 'body colour changes with theme');
});

const MOBILE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
qa('15a mobile 375px: tab bar navigation (tap)', async () => {
  const page = await newPage({ ...MOBILE, login: { email: S.member.email, password: S.member.password } });
  await page.goto('/#/');
  const bar = page.locator('#tabbar');
  await bar.waitFor({ state: 'visible' });
  await page.locator('#heroTitle').waitFor();
  assert.equal(await page.locator('#nav').isVisible(), false, 'desktop nav collapses on phones');
  // A finger tap at the tab's on-screen position. (Playwright's locator.tap() refuses here: its
  // hit-test lands on .hero-copy because the 404px-wide layout viewport pans; see test 15b.)
  const tapTab = async (k) => { const b = await bar.locator(`[data-tab=${k}]`).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  await tapTab('browse');
  await poll(() => page.evaluate(() => location.hash), (h) => h === '#/browse', 'hash #/browse');
  await page.locator('.book-card').first().waitFor();
  assert.match(await bar.locator('[data-tab=browse]').getAttribute('class'), /active/);
  await tapTab('shelf');
  await waitText(page.locator('.page-head h1'), /Hi QA/);
  assert.match(await bar.locator('[data-tab=shelf]').getAttribute('class'), /active/);
  await tapTab('home');
  await page.locator('#heroTitle').waitFor();
  assert.match(await bar.locator('[data-tab=home]').getAttribute('class'), /active/);
  assert.equal(await bar.locator('[data-tab=admin]').isVisible(), false, 'console tab hidden for members');
});

qa('15b mobile 375px: pages fit the screen (no sideways scrolling)', async () => {
  const page = await newPage({ ...MOBILE, login: { email: S.member.email, password: S.member.password } });
  const report = [];
  for (const [hash, ready] of [['#/', '#heroTitle'], ['#/browse', '.book-card'], ['#/shelf', '.wallet']]) {
    await page.goto(`/${hash}`);
    await page.locator(ready).first().waitFor();
    await sleep(800);
    const r = await page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).position !== 'fixed' && e.getBoundingClientRect().right > W + 1 && e.getBoundingClientRect().width > 0)
        .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}(right=${Math.round(e.getBoundingClientRect().right)})`);
      return { W, scrollW: document.documentElement.scrollWidth, layout: innerWidth, wide };
    });
    if (r.scrollW > r.W || r.layout > r.W) report.push(`${hash}: page is ${r.scrollW}px wide on a ${r.W}px screen; widest: ${r.wide.join(', ')}`);
  }
  assert.deepEqual(report, [], 'horizontal overflow at 375px');
});

// =================================================================== ADMIN
qa('16 admin: /admin sign-in page, member sees "Staff only", owner gets console', async () => {
  const page = await newPage();
  await page.goto('/admin');
  await waitText(page.locator('main h1'), /Sign in to the console/);
  const form = page.locator('#gateForm');
  await form.locator('[name=email]').fill(READER.email);
  await form.locator('[name=password]').fill(READER.password);
  await form.locator('#gateBtn').click();
  await waitText(page.locator('main h1'), /Staff only/);
  assert.match(await textOf(page.locator('main')), /reader@openshelf\.test, which is a member account/);
  await toast(page, /does not have staff access/);
  await page.click('#gateOut');
  await page.locator('#gateForm').waitFor();
  await page.fill('#gateForm [name=email]', ADMIN.email);
  await page.fill('#gateForm [name=password]', 'nope-nope-nope');
  await page.click('#gateBtn');
  await waitText(page.locator('#gateErr'), /Email or password is incorrect/);
  await page.fill('#gateForm [name=password]', ADMIN.password);
  await page.click('#gateBtn');
  await page.locator('.console .side').waitFor();
  const tabs = await page.locator('.side button').allInnerTexts();
  assert.equal(tabs.length, 8, `tabs: ${tabs}`);
  assert.ok(tabs.some((t) => /Tenants/.test(t)), 'owner sees Tenants');
  await waitText(page.locator('.console-head h1'), /Library overview/);
  assert.equal(new URL(page.url()).pathname, '/admin/overview');
});

qa('17 admin: every console tab loads (sidebar + deep links)', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin');
  const expect = { overview: /Library overview/, catalogue: /Catalogue/, members: /Members/, circulation: /Circulation/, developers: /API & webhooks/, settings: /Library settings/, audit: /Audit log/, tenants: /White-label tenants/ };
  for (const [k, re] of Object.entries(expect)) {
    await page.click(`.side button[data-tab=${k}]`);
    await waitText(page.locator('.console-head h1'), re, `${k} heading`);
    assert.equal(new URL(page.url()).pathname, `/admin/${k}`);
    assert.equal(await page.locator('#cm .empty h3', { hasText: 'Could not load' }).count(), 0, `${k} loaded`);
  }
  // Deep links: loading /admin/<tab> directly must open that tab (and keep the URL).
  const wrong = [];
  for (const [k, re] of Object.entries(expect)) {
    await page.goto(`/admin/${k}`);
    await page.locator('.console-head h1').waitFor();
    await sleep(300);
    const h = await textOf(page.locator('.console-head h1'));
    const p = new URL(page.url()).pathname;
    if (!re.test(h) || p !== `/admin/${k}`) wrong.push(`/admin/${k} -> "${h}" at ${p}`);
  }
  assert.deepEqual(wrong, [], 'deep links open the requested tab');
});

qa('18 admin overview: KPIs count up, chart hover tooltip shows the day values', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/overview');
  const s = await apiJson(page, '/api/admin/stats');
  const kpis = page.locator('.kpi b[data-count]');
  await kpis.first().waitFor();
  assert.equal(await kpis.count(), 4);
  await waitText(kpis.nth(0), new RegExp(`^${s.members}$`), 'members KPI');
  await waitText(kpis.nth(2), new RegExp(`^${s.utilization}%$`), 'utilisation KPI');
  const hit = page.locator('.chart-wrap .hit');
  const box = await hit.boundingBox();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  const tip = page.locator('.chart-tip');
  await poll(() => tip.evaluate((e) => e.style.opacity), (o) => o === '1', 'tooltip visible');
  const last = s.loansPerDay.length - 1;
  const txt = await textOf(tip);
  assert.match(txt, new RegExp(`Loans: ${s.loansPerDay[last].count}`), `tooltip ${txt}`);
  assert.match(txt, new RegExp(`Returns: ${s.returnsPerDay[last].count}`));
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await waitText(tip, new RegExp(`Loans: ${s.loansPerDay[0].count}`), 'tooltip follows pointer to day 1');
  await page.mouse.move(5, 5);
  await poll(() => tip.evaluate((e) => e.style.opacity), (o) => o === '0', 'tooltip hides on leave');
});

qa('19 admin catalogue: add, edit, archive, restore', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/catalogue');
  await page.click('#addBook');
  let m = modalOpen(page);
  await m.locator('[name=title]').fill('QA Admin Added Book');
  await m.locator('[name=author]').fill('QA Staff Author');
  await m.locator('[name=category]').fill('QA Admin');
  await m.locator('[name=totalCopies]').fill('2');
  await m.locator('[name=description]').fill('Added by the QA suite.');
  await m.locator('button.btn-primary').click();
  await toast(page, /Title added to the catalogue/);
  let row = page.locator('tbody tr', { hasText: 'QA Admin Added Book' });
  await row.waitFor();
  assert.equal(await row.locator('td').nth(2).innerText(), '2');
  assert.equal((await (await fetch(`${BASE}/api/books?q=QA%20Admin%20Added`)).json()).total, 1, 'visible to members');

  await page.fill('#bq', 'qa admin added');
  assert.equal(await page.locator('tbody tr:not(.hidden)').count(), 1, 'filter box narrows table');

  await row.locator('[data-edit]').click();
  m = modalOpen(page);
  assert.equal(await m.locator('[name=title]').inputValue(), 'QA Admin Added Book');
  await m.locator('[name=title]').fill('QA Admin Edited Book');
  await m.locator('[name=totalCopies]').fill('4');
  await m.locator('button.btn-primary').click();
  await toast(page, /Title updated/);
  row = page.locator('tbody tr', { hasText: 'QA Admin Edited Book' });
  await row.waitFor();
  assert.equal(await row.locator('td').nth(2).innerText(), '4');

  await row.locator('[data-archive]').click();
  await modalOpen(page).locator('[data-yes]').click();
  await toast(page, /Title archived/);
  await waitText(page.locator('tbody tr', { hasText: 'QA Admin Edited Book' }).locator('td').nth(6), /Archived/);
  assert.equal((await (await fetch(`${BASE}/api/books?q=QA%20Admin%20Edited`)).json()).total, 0, 'archived title hidden from members');

  await page.locator('tbody tr', { hasText: 'QA Admin Edited Book' }).locator('[data-archive]').click();
  await toast(page, /Title restored/);
  await waitText(page.locator('tbody tr', { hasText: 'QA Admin Edited Book' }).locator('td').nth(6), /Available/);
  assert.equal((await (await fetch(`${BASE}/api/books?q=QA%20Admin%20Edited`)).json()).total, 1, 'restored title visible again');
});

qa('20 admin members: search, credits adjust, role change, suspend/reactivate, detail modal', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/members');
  const row = () => page.locator(`tbody tr[data-id="${S.target.id}"]`);
  await row().waitFor();
  await page.fill('#mq', S.target.email);
  assert.equal(await page.locator('tbody tr:not(.hidden)').count(), 1, 'search narrows to one member');
  const before = Number(await row().locator('td').nth(2).innerText());

  await row().locator('[data-credits]').click();
  const m = modalOpen(page);
  await m.locator('[name=creditDelta]').fill('2');
  await m.locator('[name=reason]').fill('QA bonus');
  await m.locator('button.btn-primary').click();
  await toast(page, /Credits updated/);
  await waitText(row().locator('td').nth(2), new RegExp(`^${before + 2}$`), 'credits column +2');
  assert.equal((await target.get('/api/me')).data.user.credits, before + 2, 'member balance +2');

  await row().locator('select[data-role]').selectOption('admin');
  await toast(page, /Role changed to admin/);
  await waitText(row().locator('td').nth(1), /^admin$/);
  await row().locator('select[data-role]').selectOption('member');
  await toast(page, /Role changed to member/);
  await waitText(row().locator('td').nth(1), /^member$/);

  await row().locator('[data-status]').click();
  await modalOpen(page).locator('[data-yes]').click();
  await toast(page, /Member suspended/);
  await waitText(row().locator('td').nth(6), /Suspended/);
  const blocked = await client().post('/api/auth/login', { email: S.target.email, password: S.target.password });
  assert.equal(blocked.status, 403, 'suspended member cannot sign in');
  assert.match(blocked.data.error, /suspended/);
  assert.equal((await target.get('/api/me')).data.user, null, 'existing session was ended');

  await row().locator('[data-status]').click();
  await toast(page, /Member reactivated/);
  await waitText(row().locator('td').nth(6), /Active/);
  await target.login({ email: S.target.email, password: S.target.password });

  await row().locator('[data-detail]').click();
  const d = modalOpen(page);
  await waitText(d.locator('h2'), /^QA Target$/);
  await waitText(d.locator('.kpi').first(), new RegExp(`Credits\\s*${before + 2}`, 'i'));
  const body = await textOf(d);
  assert.match(body, /Credit history/);
  assert.match(body, /QA bonus\s*\S+.*\+2/);
  assert.match(body, /Welcome credits.*\+3/);
  assert.doesNotMatch(body, /Last sign-in never/, 'last sign-in recorded');
});

qa('21 admin circulation: status filters and staff check-in', async () => {
  const r = await target.post('/api/loans', { bookId: S.books.extra.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const creditsBefore = (await target.get('/api/me')).data.user.credits;
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/circulation');
  await page.locator('tbody tr').first().waitFor();
  const statuses = () => page.locator('.table-wrap').first().locator('tbody tr td:nth-child(5)').allInnerTexts();
  await poll(statuses, (s) => s.length > 0 && s.every((x) => /On loan|Overdue/.test(x)), 'active filter shows only active loans');
  // The demo seed only sometimes creates overdue loans (server/demo.js:475 skips them when the
  // copy is already out), so compare against the API instead of assuming there are some.
  const overdue = await apiJson(page, '/api/admin/loans?status=overdue');
  await page.click('.chips [data-s=overdue]');
  if (overdue.length) await poll(statuses, (s) => s.length === overdue.length && s.every((x) => /Overdue/.test(x)), 'overdue filter');
  else await waitText(page.locator('.table-wrap').first().locator('tbody'), /Nothing here/, 'overdue filter empty state');
  await page.click('.chips [data-s=returned]');
  await poll(statuses, (s) => s.length > 0 && s.every((x) => /Returned/.test(x)), 'returned filter');
  await page.click('.chips [data-s=all]');
  await poll(statuses, (s) => s.some((x) => /Returned/.test(x)) && s.some((x) => /On loan|Overdue/.test(x)), 'all filter mixes statuses');
  await page.click('.chips [data-s=active]');
  const row = page.locator('tbody tr', { hasText: S.target.email }).filter({ hasText: 'QA Second Copy' });
  await row.waitFor();
  await row.locator('[data-checkin]').click();
  await toast(page, /Copy checked in/);
  await poll(() => row.count(), (n) => n === 0, 'checked-in loan leaves the active list');
  assert.equal((await target.get('/api/me')).data.user.credits, creditsBefore + 1, 'member credit returned');
});

qa('22 admin API keys: create (shown once) and revoke', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/developers');
  const mkKey = async (name) => {
    await page.click('#newKey');
    const m = modalOpen(page);
    await m.locator('[name=name]').fill(name);
    await m.locator('button.btn-primary').click();
    const code = m.locator('.secret code');
    await code.waitFor();
    const key = await code.innerText();
    assert.match(key, /^osk_[A-Za-z0-9_-]{30,}$/);
    await m.locator('.modal-close').click();
    await page.locator('.modal.open').waitFor({ state: 'detached' });
    await page.locator('tbody tr', { hasText: name }).waitFor();
    return key;
  };
  S.apiKey = await mkKey(`QA Partner Key ${RUN}`);
  const revokeMe = await mkKey(`QA Revoke Key ${RUN}`);
  const ok = await fetch(`${BASE}/api/v1/stats`, { headers: { Authorization: `Bearer ${revokeMe}` } });
  assert.equal(ok.status, 200, 'new key works');
  const row = page.locator('tbody tr', { hasText: `QA Revoke Key ${RUN}` });
  assert.match(await row.innerText(), new RegExp(revokeMe.slice(0, 12)));
  await row.locator('[data-revoke]').click();
  await modalOpen(page).locator('[data-yes]').click();
  await toast(page, /Key revoked/);
  await waitText(page.locator('tbody tr', { hasText: `QA Revoke Key ${RUN}` }), /Revoked/);
  const dead = await fetch(`${BASE}/api/v1/stats`, { headers: { Authorization: `Bearer ${revokeMe}` } });
  assert.equal(dead.status, 401, 'revoked key is rejected');
});

qa('23 admin webhooks: add, send test (signed delivery), log, delete', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/developers');
  const url = `http://127.0.0.1:${hookServer.address().port}/hook-${RUN}`;
  await page.click('#newHook');
  const m = modalOpen(page);
  await m.locator('[name=url]').fill(url);
  await m.locator('button.btn-primary').click();
  const code = m.locator('.secret code');
  await code.waitFor();
  const secret = await code.innerText();
  assert.match(secret, /^whsec_/);
  await m.locator('.modal-close').click();
  await page.locator('.modal.open').waitFor({ state: 'detached' });
  const row = () => page.locator('tbody tr', { hasText: `hook-${RUN}` });
  await row().waitFor();

  hooks.length = 0;
  await row().locator('[data-test]').click();
  await toast(page, /Test event sent/);
  let got;
  try {
    got = await poll(() => hooks.find((h) => JSON.parse(h.body).event === 'ping'), Boolean, 'ping delivered to receiver');
  } catch (e) {
    const id = (await admin.get('/api/admin/webhooks')).data.find((h) => h.url === url)?.id;
    const log = id ? (await admin.get(`/api/admin/webhooks/${id}/deliveries`)).data : [];
    e.message += ` | receiver got ${hooks.length} request(s); server delivery log: ${JSON.stringify(log)}`;
    throw e;
  }
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(got.body).digest('hex')}`;
  assert.equal(got.headers['x-openshelf-signature'], sig, 'HMAC signature verifies');
  assert.equal(got.headers['x-openshelf-event'], 'ping');
  await waitText(row(), /1 ok/, 'delivery counter updates');

  await row().locator('[data-log]').click();
  const log = modalOpen(page);
  await waitText(log.locator('tbody tr').first(), /ping\s*delivered\s*200/);
  await log.locator('.modal-close').click();
  await page.locator('.modal.open').waitFor({ state: 'detached' });

  await row().locator('[data-del]').click();
  await modalOpen(page).locator('[data-yes]').click();
  await toast(page, /Webhook deleted/);
  await poll(() => row().count(), (n) => n === 0, 'webhook row removed');
});

qa('24 admin settings: brand colour save persists after reload', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/settings');
  const color = '#ff5fc8';
  await page.click(`.swatches [data-c="${color}"]`);
  assert.equal(await page.inputValue('[name=brandColor]'), color);
  await page.click('#sf button.btn-primary');
  await toast(page, /Settings saved/);
  await page.reload();
  await page.locator('.swatches').waitFor();
  assert.match(await page.locator(`.swatches [data-c="${color}"]`).getAttribute('class'), /active/);
  assert.equal(await page.inputValue('[name=brandColor]'), color);
  const accent = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim());
  assert.equal(await accent(), color, 'console tinted with saved colour');
  const anon = await newPage();
  await anon.goto('/#/');
  await anon.locator('#heroTitle').waitFor();
  await poll(() => anon.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim()), (c) => c === color, 'member site uses brand colour');
});

qa('25 admin tenants: owner creates a tenant', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin');
  await page.click('.side button[data-tab=tenants]');
  await page.click('#newTenant');
  const m = modalOpen(page);
  const slug = `qa-city-${RUN}`;
  await m.locator('[name=name]').fill('QA City Library');
  await m.locator('[name=slug]').fill(slug);
  await m.locator('[name=plan]').selectOption('enterprise');
  await m.locator('button.btn-primary').click();
  await toast(page, /Tenant created/);
  const row = page.locator('tbody tr', { hasText: slug });
  await row.waitFor();
  assert.match(await textOf(row), /QA City Library.*enterprise/);
});

qa('26 admin audit log shows the staff actions', async () => {
  const page = await newPage({ login: ADMIN });
  await page.goto('/admin/audit');
  await page.locator('tbody tr code').first().waitFor();
  const actions = new Set(await page.locator('tbody tr td:nth-child(3) code').allInnerTexts());
  const want = ['book.created', 'book.updated', 'book.archived', 'member.credits_adjusted', 'member.role_changed', 'member.suspended', 'member.reactivated',
    'loan.checked_in', 'api_key.created', 'api_key.revoked', 'webhook.created', 'webhook.deleted', 'tenant.settings_updated', 'tenant.created', 'member.password_changed', 'loan.renewed'];
  const missing = want.filter((a) => !actions.has(a));
  assert.deepEqual(missing, [], `missing audit actions: ${missing}`);
  assert.match(await textOf(page.locator('tbody tr', { hasText: 'member.role_changed' }).first()), /from: member · to: member|from: admin · to: member/);
});

qa('27 CSV export buttons download files with the right headers', async () => {
  const page = await newPage({ login: ADMIN });
  const cases = [
    ['catalogue', 'books', 'id,title,author,category,condition,isbn,total_copies,archived,created_at'],
    ['members', 'members', 'id,name,email,city,role,status,credits,external_id,created_at,last_login_at'],
    ['circulation', 'loans', 'id,title,member,email,status,borrowed_at,due_at,returned_at,renewals'],
    ['audit', 'audit', 'created_at,actor_label,action,target,meta'],
  ];
  for (const [tab, kind, header] of cases) {
    await page.goto(`/admin/${tab}`);
    const btn = page.locator(`a[href="/api/admin/export/${kind}"]`);
    await btn.waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    assert.match(dl.suggestedFilename(), new RegExp(`^openshelf-${kind}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
    const lines = csv.split(/\r\n/);
    assert.equal(lines[0], header, `${kind} header`);
    assert.ok(lines.length > 2, `${kind} has data rows`);
  }
});

// =================================================================== PARTNER
qa('28 partner flow: API key -> provision member -> grant credits -> login link lands on #/shelf', async () => {
  let key = S.apiKey;
  if (!key) key = (await admin.post('/api/admin/api-keys', { name: 'QA fallback key' })).data.key;
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const ext = `qa_ext_${RUN}`;
  let r = await fetch(`${BASE}/api/v1/members`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'QA Partner User', email: `qa.partner.${RUN}@example.com`, externalId: ext, credits: 4 }) });
  assert.equal(r.status, 201, await r.clone().text());
  const created = await r.json();
  assert.equal(created.credits, 4);
  r = await fetch(`${BASE}/api/v1/members/${ext}/credits`, { method: 'POST', headers: H, body: JSON.stringify({ delta: 2 }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).credits, 6);
  r = await fetch(`${BASE}/api/v1/members/${ext}/login-link`, { method: 'POST', headers: H, body: '{}' });
  assert.equal(r.status, 201);
  const { url } = await r.json();
  assert.match(url, /\/api\/auth\/sso\?token=/);

  const page = await newPage();
  await page.goto(url);
  await poll(() => page.evaluate(() => location.hash), (h) => h === '#/shelf', 'landed on #/shelf');
  await waitText(page.locator('.page-head h1'), /Hi QA/);
  await waitText(page.locator('#creditCount'), /^6$/);
  assert.equal((await apiJson(page, '/api/me')).user.email, `qa.partner.${RUN}@example.com`);

  const again = await newPage();
  await again.goto(url);
  await toast(again, /sign-in link has expired/);
  assert.equal((await apiJson(again, '/api/me')).user, null, 'link is single-use');
});

qa('29 no uncaught JavaScript errors during the run', async () => {
  assert.deepEqual(pageErrors, []);
});
