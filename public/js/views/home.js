// Landing page: 3D flying-book hero, marquee, how-it-works, features, B2B platform pitch.
import { api, store } from '../api.js';
import { esc, cover, book3d, $ } from '../ui.js';
import { reveal, splitWords, typewriter } from '../fx.js';
import { openBook } from './book.js';
import { openAuth } from './auth.js';

// Positions for the flying books in the hero scene.
const FLYERS = [
  { x: '34%', y: '18%', z: 120, ry: -28, rx: 10, rz: -6, dur: 9, delay: 0 },
  { x: '6%', y: '40%', z: -60, ry: 32, rx: 6, rz: 8, dur: 11, delay: -3 },
  { x: '62%', y: '44%', z: 40, ry: -42, rx: -6, rz: 10, dur: 10, delay: -6 },
  { x: '20%', y: '68%', z: 200, ry: 18, rx: 14, rz: -12, dur: 12, delay: -2 },
  { x: '70%', y: '6%', z: -140, ry: -18, rx: 4, rz: 14, dur: 13, delay: -8 },
  { x: '48%', y: '72%', z: -40, ry: -60, rx: 8, rz: -4, dur: 10.5, delay: -5 },
];

export async function renderHome(app, { anchor } = {}) {
  const [stats, books] = await Promise.all([
    api('/api/stats/public').catch(() => ({ titles: 0, copies: 0, members: 0, loans: 0, onLoanNow: 0 })),
    api('/api/books?sort=popular&limit=24').then((r) => r.items).catch(() => []),
  ]);
  const flyers = FLYERS.map((f, i) => ({ f, b: books[i % Math.max(books.length, 1)] })).filter((x) => x.b);
  const half = Math.ceil(books.length / 2);
  const rowA = books.slice(0, half), rowB = books.slice(half).concat(books.slice(0, 3));
  const brand = store.tenant?.name || 'Open Shelf';

  app.innerHTML = `
  <section class="wrap hero">
    <div class="hero-copy">
      <div data-reveal><span class="eyebrow"><span class="pulse-dot"></span>${stats.onLoanNow} books travelling between readers right now</span></div>
      <h1 id="heroTitle">Every book deserves <em>another reader.</em></h1>
      <p class="hero-sub" data-reveal style="--i:3">Borrow real paperbacks with credits, keep them for ${store.tenant?.loanDays || 21} days, then pass them on. ${esc(brand)} turns every shelf into a shared, living library.</p>
      <div class="hero-ctas" data-reveal style="--i:4">
        <a class="btn btn-primary lg magnetic" href="#/browse"><span>Explore the shelves</span> <span class="arrow">↗</span></a>
        <a class="btn btn-ghost lg" href="#/#platforms">For platforms &amp; partners</a>
      </div>
      <div class="hero-stats" data-reveal style="--i:5">
        <div><b data-count="${stats.titles}">0</b><span>titles</span></div>
        <div><b data-count="${stats.members}">0</b><span>readers</span></div>
        <div><b data-count="${stats.loans}">0</b><span>loans so far</span></div>
      </div>
    </div>
    <div class="scene" aria-hidden="true">
      <div class="orb a"></div><div class="orb b"></div><div class="orb c"></div>
      <div class="scene-inner">
        <div class="ring"></div><div class="ring r2"></div>
        ${flyers.map(({ f, b }) => `<button class="flyer" data-book="${esc(b.id)}" tabindex="-1" style="--x:${f.x};--y:${f.y};--z:${f.z}px;--rz:${f.rz}deg;--dur:${f.dur}s;--delay:${f.delay}s">${book3d(b, `--ry:${f.ry}deg;--rx:${f.rx}deg`)}</button>`).join('')}
        ${Array.from({ length: 5 }, (_, i) => `<span class="page-fly" style="left:${10 + i * 12}%;top:${55 + (i % 3) * 10}%;--dur:${11 + i * 2}s;--delay:${-i * 2.6}s"></span>`).join('')}
      </div>
      <div class="float-card" style="left:2%;top:12%"><span class="fc-ico">📚</span><div><b>${stats.copies} copies</b><small>on the shelves</small></div></div>
      <div class="float-card" style="right:0;bottom:16%;animation-delay:-3s"><span class="fc-ico" style="background:color-mix(in srgb,var(--good) 18%,transparent)">↩</span><div><b>Returned & re-lent</b><small>credits flow back instantly</small></div></div>
    </div>
    <a class="scroll-hint" href="#how"><i></i>Scroll</a>
  </section>

  <div class="marquee" data-reveal><div class="marquee-track">${[...rowA, ...rowA].map((b) => `<button data-book="${esc(b.id)}" aria-label="${esc(b.title)}">${cover(b)}</button>`).join('')}</div></div>
  <div class="marquee reverse" style="border-top:0"><div class="marquee-track">${[...rowB, ...rowB].map((b) => `<button data-book="${esc(b.id)}" aria-label="${esc(b.title)}">${cover(b)}</button>`).join('')}</div></div>

  <section class="section wrap" id="how">
    <div class="section-head"><span class="eyebrow" data-reveal>How it works</span><h2 data-reveal style="--i:1">Three steps. <em class="grad-text">Stories keep moving.</em></h2></div>
    <div class="steps">
      <svg class="steps-line" viewBox="0 0 100 2" preserveAspectRatio="none"><path d="M0 1 H100"/></svg>
      ${[
    ['◈', 'Join & get credits', `Create a free account. Your wallet starts with ${store.tenant?.welcomeCredits ?? 3} borrowing credits.`],
    ['↗', 'Borrow a paperback', 'Pick any available book. One credit is held while it’s on your shelf — no fees, no fines.'],
    ['↩', 'Return & repeat', 'Bring it back and your credit returns instantly. The next reader on the waitlist gets notified.'],
  ].map(([ico, h, p], i) => `<article class="card step" data-reveal style="--i:${i}"><span class="step-num">0${i + 1}</span><div class="step-ico">${ico}</div><h3>${h}</h3><p>${p}</p></article>`).join('')}
    </div>
  </section>

  <section class="section wrap" style="padding-top:0">
    <div class="section-head"><span class="eyebrow" data-reveal>Built like a real product</span><h2 data-reveal style="--i:1">Everything a modern <em>library</em> needs.</h2></div>
    <div class="bento">
      <article class="card tile w4 tall" data-reveal>
        <div class="tile-art" style="height:68%;perspective:900px">${books.slice(0, 3).map((b, i) => `<div style="position:absolute;left:${22 + i * 20}%;top:16%;transform:translateZ(${i * 30}px)">${book3d(b, `--w:120px;--h:180px;--d:24px;--ry:${-30 + i * 22}deg`)}</div>`).join('')}</div>
        <h3>A catalogue people love to browse</h3><p>Real covers, instant search, genre filters, live availability and ratings — tuned for phones first.</p>
      </article>
      <article class="card tile w2" data-reveal style="--i:1"><div class="tile-art"><div class="mini-queue">${['A', 'S', 'M', 'R'].map((l, i) => `<span style="--i:${i};background:${['#7c5cbf', '#e0794f', '#4fb39a', '#5aa6d6'][i]}">${l}</span>`).join('')}</div></div><h3>Smart waitlists</h3><p>Fair FIFO holds, auto-promotion and expiry.</p></article>
      <article class="card tile w2" data-reveal style="--i:2"><div class="tile-art"><div class="mini-chart">${[40, 65, 50, 80, 70, 95, 85].map((h, i) => `<i style="height:${h}%;--i:${i}"></i>`).join('')}</div></div><h3>Live analytics</h3><p>Utilisation, overdue, top titles, growth.</p></article>
      <article class="card tile w2" data-reveal><div class="tile-art"><span class="coin" style="width:72px;height:72px;font-size:34px">◈</span></div><h3>Credit wallet</h3><p>Ledgered, auditable, partner-grantable.</p></article>
      <article class="card tile w2" data-reveal style="--i:1"><div class="tile-art"><div class="phone"><i></i><i></i><i></i></div></div><h3>Web + Android app</h3><p>Installable PWA and native wrapper.</p></article>
      <article class="card tile w2" data-reveal style="--i:2"><div class="tile-art" style="font-size:54px">🔔</div><h3>Notifications</h3><p>Due dates, holds ready, overdue nudges.</p></article>
    </div>
  </section>

  <section class="section platforms" id="platforms">
    <div class="wrap">
      <div class="platform-grid">
        <div>
          <div class="section-head" style="margin-bottom:30px"><span class="eyebrow" data-reveal>For platforms & partners</span>
            <h2 data-reveal style="--i:1">Plug a lending library into <em class="grad-text">your platform.</em></h2>
            <p data-reveal style="--i:2">Universities, telcos, bookstores, HR-benefit and super-apps launch a branded book-sharing program in days — not months.</p></div>
          <div class="feature-list">
            ${[
    ['🏷️', 'White-label & multi-tenant', 'Each partner gets its own catalogue, members, rules and brand colour.'],
    ['🔑', 'Partner REST API', 'Provision members, import catalogues in bulk, grant credits from your billing.'],
    ['🪪', 'One-click SSO hand-off', 'Signed one-time login links drop your users straight into their shelf.'],
    ['📡', 'Signed webhooks', 'loan.created, loan.overdue, reservation.ready… HMAC-SHA256 signed.'],
    ['🛡️', 'Audit log & roles', 'Every staff and API action is recorded. Admin, owner and member roles.'],
  ].map(([i, b, p], k) => `<div class="feature" data-reveal style="--i:${k}"><span class="f-ico">${i}</span><div><b>${b}</b><p>${p}</p></div></div>`).join('')}
          </div>
        </div>
        <div data-reveal="right">
          <div class="terminal"><div class="term-bar"><i></i><i></i><i></i><span>partner-integration.sh</span></div><pre class="term-body" id="term"></pre></div>
          <div class="logos"><span>Campus libraries</span><span>Telco rewards</span><span>Bookstores</span><span>HR benefits</span><span>Super-apps</span></div>
        </div>
      </div>
      <div class="plans">
        ${[
    ['Starter', 'For a single library or campus', ['Up to 2,000 members', 'Web + Android app', 'Admin console & analytics', 'Email support'], false],
    ['Growth', 'For multi-branch networks', ['Up to 25,000 members', 'Partner API & webhooks', 'Custom branding & domain', 'Priority support'], true],
    ['Enterprise', 'For platforms at scale', ['Unlimited members & tenants', 'SSO hand-off & bulk import', 'Audit exports & SLA', 'Dedicated success manager'], false],
  ].map(([name, sub, feats, featured], i) => `<article class="card plan ${featured ? 'featured' : ''}" data-reveal style="--i:${i}">
          ${featured ? '<span class="tag tag-warn" style="justify-self:start">Most popular</span>' : ''}
          <h3>${name}</h3><p class="muted">${sub}</p><div class="price">Custom <small>/ per active member</small></div>
          <ul>${feats.map((f) => `<li>${f}</li>`).join('')}</ul>
          <a class="btn ${featured ? 'btn-primary' : 'btn-ghost'}" href="mailto:partners@openshelf.example?subject=${encodeURIComponent(`${name} plan`)}">Talk to sales <span class="arrow">↗</span></a>
        </article>`).join('')}
      </div>
    </div>
  </section>

  <section class="wrap" style="padding-bottom:20px">
    <div class="cta-band" data-reveal="zoom">
      <span class="eyebrow">Ready when you are</span>
      <h2>Your next favourite book is <em>already on someone's shelf.</em></h2>
      <div class="hero-ctas" style="justify-content:center">
        ${store.me ? '<a class="btn btn-primary lg magnetic" href="#/browse"><span>Find a book</span> <span class="arrow">↗</span></a>' : '<button class="btn btn-primary lg magnetic" id="ctaJoin"><span>Join free — get 3 credits</span> <span class="arrow">↗</span></button>'}
        ${store.isStaff ? '<a class="btn btn-ghost lg" href="#/admin">Open console</a>' : ''}
      </div>
    </div>
    <footer class="footer"><span>© ${new Date().getFullYear()} ${esc(brand)} · A shared library for readers</span>
      <nav><a href="#/browse">Browse</a><a href="#/#platforms">Platforms</a><a href="/api/openapi.json" target="_blank" rel="noopener">API</a></nav></footer>
  </section>`;

  splitWords($('#heroTitle', app));
  reveal(app);
  app.querySelectorAll('[data-book]').forEach((el) => el.addEventListener('click', () => openBook(el.dataset.book)));
  $('#ctaJoin', app)?.addEventListener('click', () => openAuth('register'));

  const term = $('#term', app);
  term.parentElement._onReveal = () => typewriter(term, [
    ['c', '# 1 · Provision a member from your platform\n'],
    ['k', 'curl'], ['', ' -X POST '], ['p', '/api/v1/members'], ['', ' \\\n  -H '], ['s', '"Authorization: Bearer osk_live_…"'], ['', ' \\\n  -d '], ['s', `'{"email":"amna@uni.edu","externalId":"stu_4821"}'`], ['', '\n\n'],
    ['c', '# 2 · Grant credits after a subscription payment\n'],
    ['k', 'curl'], ['', ' -X POST '], ['p', '/api/v1/members/stu_4821/credits'], ['', ' -d '], ['s', `'{"delta":5}'`], ['', '\n\n'],
    ['c', '# 3 · Hand the user into their shelf (SSO)\n'],
    ['k', 'curl'], ['', ' -X POST '], ['p', '/api/v1/members/stu_4821/login-link'], ['', '\n'],
    ['s', '→ { "url": "https://…/api/auth/sso?token=…" }'], ['', '\n'],
  ]);
  const termWrap = term.closest('[data-reveal]');
  if (termWrap) termWrap._onReveal = term.parentElement._onReveal;

  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }));
}
