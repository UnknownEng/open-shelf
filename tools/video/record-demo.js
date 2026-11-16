// Records a narrated product walkthrough of Open Shelf.
// Usage: node record-demo.js <projectDir> <outDir>
'use strict';
const { chromium } = require('playwright-core');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROJECT = process.argv[2];
const OUT = process.argv[3];
const WORK = path.join(__dirname, 'work-demo');
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const W = 1440, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = [
  { say: "This is Open Shelf: Pakistan's book sharing library, for real, physical books.", cap: "Open Shelf — Pakistan's book-sharing library" },
  { say: 'Readers borrow books with credits, then pass them on. No fines, no fees.', cap: 'Borrow with credits · no fines · pass it on' },
  { say: 'Partners plug it into their own platform through a complete API.', cap: 'Built to plug into partner platforms' },
  { say: 'The catalogue mixes Urdu classics and English bestsellers, with live availability and instant search.', cap: 'Urdu adab + English · live availability' },
  { say: 'Every book has its own page, with copies, reviews, and one tap to borrow.', cap: 'Book page with copies and reviews' },
  { say: 'Borrowing costs one credit, and the book flies straight onto your shelf.', cap: 'One credit → straight onto your shelf' },
  { say: 'Your shelf tracks due dates, renewals, your waitlist, and your credit wallet.', cap: 'My shelf: due dates, renewals, wallet' },
  { say: 'Library staff sign in at slash admin, to a live console with members, loans and trends.', cap: '/admin — staff console with live analytics' },
  { say: 'Developers get API keys, signed webhooks, and a full endpoint reference.', cap: 'Partner API · SSO links · signed webhooks' },
  { say: 'And every partner can white-label the whole experience with their own brand colour.', cap: 'White-label: one click re-brands everything' },
  { say: 'Open Shelf. Read it. Pass it. Repeat.', cap: 'Open Shelf — read it · pass it · repeat' },
];

const OVERLAY = `(() => {
  const mk = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 0 0 6px rgba(244,184,96,.35),0 4px 14px rgba(0,0,0,.4);pointer-events:none;transition:transform .15s;';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
    const cap = document.createElement('div');
    cap.id = '__cap';
    cap.style.cssText = 'position:fixed;z-index:2147483646;left:50%;bottom:34px;transform:translateX(-50%);padding:14px 26px;border-radius:999px;background:rgba(10,12,19,.82);color:#f4efe6;font:700 21px Manrope,system-ui,sans-serif;letter-spacing:.01em;border:1px solid rgba(255,255,255,.14);box-shadow:0 20px 50px rgba(0,0,0,.45);backdrop-filter:blur(12px);transition:opacity .35s;opacity:0;white-space:nowrap;pointer-events:none;';
    document.documentElement.appendChild(cap);
    if (window.__capText) { cap.textContent = window.__capText; cap.style.opacity = 1; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
  window.__setCap = (t) => { window.__capText = t; mk(); const cap = document.getElementById('__cap'); cap.style.opacity = 0; setTimeout(() => { cap.textContent = t; cap.style.opacity = t ? 1 : 0; }, 250); };
})();`;

async function glide(page, x, y, steps = 25) { await page.mouse.move(x, y, { steps }); }

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

  // 1. Narration
  fs.writeFileSync(path.join(WORK, 'lines.json'), JSON.stringify(STEPS.map((s) => s.say)));
  const durs = JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tts.ps1'),
    '-LinesJson', path.join(WORK, 'lines.json'), '-OutDir', path.join(WORK, 'audio'), '-Voice', 'Microsoft Zira Desktop'], { encoding: 'utf8' }).trim());
  console.log('narration seconds', durs);

  // 2. Fresh demo server
  const db = path.join(os.tmpdir(), `openshelf-video-${Date.now()}.sqlite`);
  const env = { ...process.env, DB_PATH: db, PORT: String(PORT), LOG: '0' };
  execFileSync(process.execPath, ['server/demo.js'], { cwd: PROJECT, env });
  const server = spawn(process.execPath, ['server/index.js'], { cwd: PROJECT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ } await sleep(100); }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.addInitScript(OVERLAY);
  await context.request.post(`${BASE}/api/auth/login`, { data: { email: 'reader@openshelf.test', password: 'DemoReader!2026' }, headers: { Origin: BASE } });
  const page = await context.newPage();
  await page.goto(`${BASE}/#/`);
  await page.waitForTimeout(2500);

  // 3. Screencast capture
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = path.join(WORK, 'frames', `${String(n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ t: metadata.timestamp, file });
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* closed */ }
  });
  const startCast = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 }).catch(() => {});
  await startCast();
  // Keep frames flowing even on static screens.
  const ticker = setInterval(() => page.evaluate(() => { document.body.style.outlineColor = `rgba(0,0,0,${Math.random() * 0.01})`; }).catch(() => {}), 40);

  const marks = [];
  const shot = (name) => page.screenshot({ path: path.join(OUT, 'screenshots', `${name}.png`) });

  async function step(i, act) {
    const started = Date.now();
    marks.push(started / 1000);
    await page.evaluate((t) => window.__setCap(t), STEPS[i].cap);
    await act();
    const remaining = (durs[i] + 0.7) * 1000 - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);
  }

  await glide(page, 900, 420, 5);
  await step(0, async () => {
    await shot('01-home');
    for (const [x, y] of [[1100, 300], [980, 560], [1200, 480], [1000, 380]]) await glide(page, x, y, 40);
  });
  await step(1, async () => {
    await page.evaluate(() => window.scrollTo({ top: innerHeight * 0.95, behavior: 'smooth' }));
    await sleep(1600);
    await page.evaluate(() => document.getElementById('how').scrollIntoView({ behavior: 'smooth' }));
    await sleep(1200);
  });
  await step(2, async () => {
    await page.evaluate(() => document.getElementById('platforms').scrollIntoView({ behavior: 'smooth' }));
    await sleep(2200);
    await shot('02-platforms');
  });
  await step(3, async () => {
    await page.evaluate(() => { location.hash = '#/browse'; window.scrollTo(0, 0); });
    await sleep(1200);
    const q = await page.$('#q');
    const box = await q.boundingBox();
    await glide(page, box.x + 120, box.y + box.height / 2);
    await page.mouse.click(box.x + 120, box.y + box.height / 2);
    await page.keyboard.type('the', { delay: 140 });
    await sleep(900);
    await shot('03-browse');
    await page.fill('#q', '');
    await page.dispatchEvent('#q', 'input');
    const chip = page.locator('.chip', { hasText: 'Urdu adab' });
    await chip.first().scrollIntoViewIfNeeded();
    const cb = await chip.first().boundingBox();
    await glide(page, cb.x + cb.width / 2, cb.y + cb.height / 2);
    await chip.first().click();
    await sleep(900);
    const all = page.locator('.chip', { hasText: 'All' });
    await all.first().scrollIntoViewIfNeeded();
    const ab = await all.first().boundingBox();
    await glide(page, ab.x + ab.width / 2, ab.y + ab.height / 2);
    await all.first().click();
    await sleep(700);
  });
  const pickId = await page.evaluate(async () => {
    const r = await fetch('/api/books?availability=available&sort=popular&limit=50').then((x) => x.json());
    return (r.items.find((b) => !b.myLoan && b.cover && !['b1', 'b3'].includes(b.id)) || r.items[0]).id;
  });
  await step(4, async () => {
    const card = page.locator(`.book-card[data-id="${pickId}"]`);
    await card.scrollIntoViewIfNeeded();
    await sleep(500);
    const b = await card.boundingBox();
    await glide(page, b.x + b.width / 2, b.y + b.height * 0.35);
    await sleep(500);
    await card.locator('.tilt').click();
    await sleep(1800);
    await shot('04-book');
  });
  await step(5, async () => {
    const btn = page.locator('[data-act="borrow"]');
    const bb = await btn.boundingBox();
    await glide(page, bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(300);
    await btn.click();
    await sleep(2600);
    await page.keyboard.press('Escape');
    await sleep(500);
  });
  await step(6, async () => {
    await page.evaluate(() => { location.hash = '#/shelf'; });
    await sleep(2200);
    await shot('05-shelf');
    await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
    await sleep(1400);
  });

  // Switch to the staff account.
  await page.evaluate(async (base) => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@openshelf.test', password: 'DemoAdmin!2026' }) });
  }, BASE);
  await step(7, async () => {
    await page.goto(`${BASE}/admin/overview`);
    await page.reload();
    await page.waitForSelector('.chart-wrap', { timeout: 10000 });
    await startCast();
    await page.evaluate((t) => window.__setCap(t), STEPS[7].cap);
    await sleep(2400);
    await shot('06-console');
    await page.evaluate(() => window.scrollTo({ top: 380, behavior: 'smooth' }));
    await sleep(900);
    const chart = await page.locator('.chart-wrap').boundingBox();
    for (let k = 0.15; k <= 0.95; k += 0.2) await glide(page, chart.x + chart.width * k, chart.y + chart.height * 0.5, 12);
  });
  await step(8, async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const tab = page.locator('.side [data-tab="developers"]');
    const tb = await tab.boundingBox();
    await glide(page, tb.x + 60, tb.y + tb.height / 2);
    await tab.click();
    await sleep(1800);
    await shot('07-developers');
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
    await sleep(800);
  });
  await step(9, async () => {
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    const tab = page.locator('.side [data-tab="settings"]');
    const tb = await tab.boundingBox();
    await glide(page, tb.x + 60, tb.y + tb.height / 2);
    await tab.click();
    await sleep(1400);
    for (const c of ['#4d5bff', '#ff5fc8', '#ffd23f']) {
      const sw = page.locator(`.swatches [data-c="${c}"]`);
      const sb = await sw.boundingBox();
      await glide(page, sb.x + sb.width / 2, sb.y + sb.height / 2, 12);
      await sw.click();
      await sleep(900);
    }
    await shot('08-whitelabel');
  });
  await step(10, async () => {
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(800);
    await glide(page, 1050, 420, 30);
    await sleep(1500);
  });
  marks.push(Date.now() / 1000);
  await sleep(600);
  clearInterval(ticker);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();
  server.kill();

  // 4. Assemble video (variable frame timing → constant 30fps) + narration.
  const t0 = marks[0] - 0.4;
  const end = marks[marks.length - 1];
  const used = frames.filter((f) => f.t <= end + 0.5).sort((a, b) => a.t - b.t);
  let list = '';
  let firstIdx = used.findIndex((f) => f.t >= t0);
  if (firstIdx > 0) firstIdx -= 1;
  for (let i = Math.max(firstIdx, 0); i < used.length; i++) {
    const next = used[i + 1] ? used[i + 1].t : end + 0.5;
    const startT = Math.max(used[i].t, t0);
    const d = Math.max(0.001, next - startT);
    list += `file '${used[i].file.replace(/\\/g, '/')}'\nduration ${d.toFixed(4)}\n`;
  }
  list += `file '${used[used.length - 1].file.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(path.join(WORK, 'frames.txt'), list);
  console.log('frames', used.length, 'clock check', (frames[0]?.t - marks[0]).toFixed(2));

  const inputs = [];
  const filters = [];
  STEPS.forEach((_, i) => {
    inputs.push('-i', path.join(WORK, 'audio', `${String(i).padStart(2, '0')}.wav`));
    const delay = Math.max(0, Math.round((marks[i] - t0) * 1000) + 200);
    filters.push(`[${i + 1}:a]adelay=${delay}|${delay}[a${i}]`);
  });
  const mix = `${filters.join(';')};${STEPS.map((_, i) => `[a${i}]`).join('')}amix=inputs=${STEPS.length}:normalize=0,volume=1.6[aout]`;
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'frames.txt'), ...inputs,
    '-filter_complex', `[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.6[v];${mix}`,
    '-map', '[v]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest',
    path.join(OUT, 'open-shelf-website-demo.mp4')], { stdio: 'inherit' });
  console.log('done', path.join(OUT, 'open-shelf-website-demo.mp4'));
}

main().catch((e) => { console.error(e); process.exit(1); });
