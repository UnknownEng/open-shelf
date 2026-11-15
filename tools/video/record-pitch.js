// Records the narrated pitch deck. Usage: node record-pitch.js <outDir>
'use strict';
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const OUT = process.argv[2];
const WORK = path.join(__dirname, 'work-pitch');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LINES = [
  'Open Shelf. Library as a service, for physical books.',
  "Millions of great books sit unread on shelves. Buying new is expensive, libraries are hard to reach, and e-book subscriptions don't cover the paperbacks people actually want.",
  'Open Shelf fixes that with credits. One credit borrows one book. Return it, and the credit comes straight back, while the next reader on the waitlist is notified.',
  "It's a polished, mobile-first product, with a live catalogue, instant search, ratings, and fair waitlists.",
  'Readers manage due dates, renewals, and their credit wallet in one place.',
  'Libraries run everything from a live console, with utilisation, overdue tracking, growth trends, and a full audit log.',
  'And it is built for partners. Universities, telecoms, bookstores and benefit platforms can launch a branded library in days, using our API, single sign-on links, and signed webhooks.',
  'Partners pay per active member, with setup and enterprise tiers, and can bundle credits into their own plans, so every borrow drives engagement on their platform.',
  "We start with a ninety day pilot, measure borrowing, retention and on-time returns, then scale across the partner's network.",
  "We're looking for our first pilot partners. Let's put a shared library inside your platform. Open Shelf: every book deserves another reader.",
];

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'lines.json'), JSON.stringify(LINES));
  const durs = JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tts.ps1'),
    '-LinesJson', path.join(WORK, 'lines.json'), '-OutDir', path.join(WORK, 'audio'), '-Voice', 'Microsoft Zira Desktop'], { encoding: 'utf8' }).trim());
  console.log('narration', durs);

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(__dirname, 'pitch.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await sleep(1500);

  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = path.join(WORK, 'frames', `${String(n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ t: metadata.timestamp, file });
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* closed */ }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 });
  await sleep(300);

  const marks = [];
  for (let i = 0; i < LINES.length; i++) {
    marks.push(Date.now() / 1000);
    await page.evaluate((k) => window.go(k), i);
    await sleep((durs[i] + 1.1) * 1000);
  }
  marks.push(Date.now() / 1000);
  await sleep(400);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();

  const t0 = marks[0] - 0.2;
  const end = marks[marks.length - 1];
  const used = frames.sort((a, b) => a.t - b.t);
  let list = '';
  let first = used.findIndex((f) => f.t >= t0);
  first = Math.max(0, first - 1);
  for (let i = first; i < used.length && used[i].t <= end + 0.3; i++) {
    const next = used[i + 1] ? used[i + 1].t : end + 0.3;
    list += `file '${used[i].file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, next - Math.max(used[i].t, t0)).toFixed(4)}\n`;
  }
  list += `file '${used[used.length - 1].file.replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(path.join(WORK, 'frames.txt'), list);
  console.log('frames', used.length, 'clock check', (used[0].t - marks[0]).toFixed(2));

  const inputs = [];
  const filters = [];
  LINES.forEach((_, i) => {
    inputs.push('-i', path.join(WORK, 'audio', `${String(i).padStart(2, '0')}.wav`));
    const delay = Math.max(0, Math.round((marks[i] - t0) * 1000) + 450);
    filters.push(`[${i + 1}:a]adelay=${delay}|${delay}[a${i}]`);
  });
  const total = (end - t0).toFixed(2);
  const mix = `${filters.join(';')};${LINES.map((_, i) => `[a${i}]`).join('')}amix=inputs=${LINES.length}:normalize=0,volume=1.6[aout]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'frames.txt'), ...inputs,
    '-filter_complex', `[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.8,fade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[v];${mix}`,
    '-map', '[v]', '-map', '[aout]', '-t', total, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    path.join(OUT, 'open-shelf-pitch.mp4')], { stdio: 'inherit' });
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
