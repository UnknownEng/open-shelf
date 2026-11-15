// Staff console: analytics, catalogue, members, circulation, developers (API keys/webhooks), settings, audit.
import { api, store, refreshMe } from '../api.js';
import { esc, cover, fmtDate, fmtShort, relTime, toast, modal, confirmDialog, copyText, applyBrand, $ } from '../ui.js';
import { reveal } from '../fx.js';

const TABS = [
  ['overview', '◎', 'Overview'], ['catalogue', '📚', 'Catalogue'], ['members', '👥', 'Members'], ['circulation', '↺', 'Circulation'],
  ['developers', '⌘', 'API & webhooks'], ['settings', '⚙', 'Settings'], ['audit', '🛡', 'Audit log'],
];
let current = 'overview';

export async function renderAdmin(app, { sub } = {}) {
  if (!store.isStaff) {
    app.innerHTML = `<section class="wrap"><div class="empty" style="padding-top:120px"><div class="big">🔒</div><h3>Staff only</h3><p>The console is available to library admins. ${store.me ? 'Ask an owner to grant you access.' : 'Please sign in with a staff account.'}</p><a class="btn btn-ghost" href="#/">Back home</a></div></section>`;
    return;
  }
  if (sub && TABS.some((t) => t[0] === sub)) current = sub;
  const tabs = store.me.role === 'owner' ? [...TABS, ['tenants', '🏢', 'Tenants']] : TABS;
  app.innerHTML = `<section class="wrap console">
    <aside class="side"><div class="side-title">${esc(store.tenant?.name || 'Console')}</div>
      ${tabs.map(([k, i, l]) => `<button data-tab="${k}" class="${k === current ? 'active' : ''}"><i>${i}</i>${l}</button>`).join('')}</aside>
    <div class="console-main" id="cm"></div></section>`;
  const main = $('#cm', app);
  const show = async (k) => {
    current = k;
    history.replaceState(null, '', `#/admin/${k}`);
    app.querySelectorAll('.side button').forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
    main.innerHTML = '<div class="skeleton" style="height:60px"></div><div class="kpis">' + '<div class="skeleton" style="height:120px"></div>'.repeat(4) + '</div><div class="skeleton" style="height:320px"></div>';
    try { await PANES[k](main); } catch (err) { main.innerHTML = `<div class="empty"><div class="big">⚠︎</div><h3>Could not load</h3><p>${esc(err.message)}</p></div>`; }
    main.classList.remove('view-enter'); void main.offsetWidth; main.classList.add('view-enter');
    reveal(main);
  };
  $('.side', app).addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
  show(current);
}

const head = (title, sub, actions = '') => `<div class="console-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="detail-actions">${actions}</div></div>`;
const roleTag = (r) => `<span class="tag ${r === 'owner' ? 'tag-warn' : r === 'admin' ? 'tag-info' : 'tag-mute'}">${r}</span>`;

// ---------------------------------------------------------------- charts
function spark(data, color) {
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${40 - (v / max) * 36}`).join(' ');
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function lineChart(series) {
  const W = 640, H = 240, P = { l: 30, r: 10, t: 10, b: 26 };
  const n = series[0].data.length;
  const max = Math.max(4, ...series.flatMap((s) => s.data.map((d) => d.count)));
  const x = (i) => P.l + (i / (n - 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const smooth = (pts) => pts.reduce((acc, [px, py], i, a) => {
    if (!i) return `M${px},${py}`;
    const [qx, qy] = a[i - 1], cx = (qx + px) / 2;
    return `${acc} C${cx},${qy} ${cx},${py} ${px},${py}`;
  }, '');
  const grid = [0, .25, .5, .75, 1].map((f) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="axis" x="${P.l - 8}" y="${y(max * f) + 4}" text-anchor="end">${Math.round(max * f)}</text>`).join('');
  const labels = series[0].data.map((d, i) => (i % 5 === 0 || i === n - 1 ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtShort(d.date)}</text>` : '')).join('');
  const paths = series.map((s, si) => {
    const pts = s.data.map((d, i) => [x(i), y(d.count)]);
    const line = smooth(pts);
    return `<defs><linearGradient id="g${si}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".35"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#g${si})" opacity="0"><animate attributeName="opacity" to="1" dur="1.2s" begin="0.4s" fill="freeze"/></path>
      <path class="line draw" d="${line}" stroke="${s.color}"/>`;
  }).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}">${grid}${labels}${paths}<line class="hover-line" y1="${P.t}" y2="${H - P.b}" stroke="var(--line-2)" opacity="0"/><rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent"/></svg><div class="chart-tip"></div></div>`;
}

function wireChart(root, series) {
  const wrap = $('.chart-wrap', root);
  if (!wrap) return;
  wrap.querySelectorAll('.draw').forEach((p) => p.style.setProperty('--len', p.getTotalLength()));
  const svg = $('svg', wrap), tip = $('.chart-tip', wrap), line = $('.hover-line', wrap), n = series[0].data.length;
  $('.hit', wrap).addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width * 640 - 30) / (600 / (n - 1)));
    const idx = Math.max(0, Math.min(n - 1, i));
    const vx = 30 + (idx / (n - 1)) * 600;
    line.setAttribute('x1', vx); line.setAttribute('x2', vx); line.setAttribute('opacity', 1);
    tip.style.left = `${(vx / 640) * 100}%`; tip.style.top = '30%'; tip.style.opacity = 1;
    tip.innerHTML = `${fmtShort(series[0].data[idx].date)}<br>${series.map((s) => `<span style="color:${s.color}">●</span> ${s.name}: ${s.data[idx].count}`).join('<br>')}`;
  });
  $('.hit', wrap).addEventListener('pointerleave', () => { tip.style.opacity = 0; line.setAttribute('opacity', 0); });
}

// ---------------------------------------------------------------- panes
const PANES = {
  async overview(el) {
    const s = await api('/api/admin/stats');
    const loans = s.loansPerDay.map((d) => d.count), signups = s.signupsPerDay.map((d) => d.count);
    const maxGenre = Math.max(1, ...s.genres.map((g) => g.loans));
    const series = [{ name: 'Loans', color: 'var(--accent)', data: s.loansPerDay }, { name: 'Returns', color: 'var(--accent-3)', data: s.returnsPerDay }];
    el.innerHTML = `${head('Library <em>overview</em>', `Live numbers for ${esc(store.tenant?.name || 'your library')} · last 30 days`, '<a class="btn btn-ghost sm" href="/api/openapi.json" target="_blank" rel="noopener">API spec</a>')}
      <div class="kpis">
        ${[
    ['Members', s.members, `+${s.newMembers30d} this month`, 'var(--good)', spark(signups, 'var(--good)')],
    ['Loans · 30d', s.loans30d, `${s.activeMembers30d} active readers`, 'var(--accent)', spark(loans, 'var(--accent)')],
    ['Utilisation', s.utilization, `${s.onLoan} of ${s.copies} copies out`, 'var(--accent-3)', '', '%'],
    ['Overdue', s.overdue, `${s.onTimeRate}% returned on time`, s.overdue ? 'var(--bad)' : 'var(--good)', ''],
  ].map(([l, v, sub, c, sp, suf = ''], i) => `<div class="card kpi" data-reveal style="--i:${i}"><span>${l}</span><b data-count="${v}" data-suffix="${suf}">0</b><small style="color:${c}">${sub}</small>${sp}</div>`).join('')}
      </div>
      <div class="card panel" data-reveal><div class="panel-head"><h3>Circulation</h3><div class="legend"><span><i style="background:var(--accent)"></i>Loans</span><span><i style="background:var(--accent-3)"></i>Returns</span></div></div>${lineChart(series)}</div>
      <div class="two-col">
        <div class="card panel" data-reveal><div class="panel-head"><h3>Most borrowed</h3><span class="tag tag-mute">★ ${s.avgRating ?? '—'} avg rating</span></div>
          <div class="top-list">${s.topBooks.map((b, i) => `<div class="top-item"><span class="rank">${i + 1}</span>${cover(b)}<div><b>${esc(b.title)}</b><small>${esc(b.author)}</small></div><span class="tag tag-mute">${b.loans} loans</span></div>`).join('') || '<p class="muted">No loans yet.</p>'}</div></div>
        <div class="card panel" data-reveal style="--i:1"><div class="panel-head"><h3>Genres</h3><span class="tag tag-mute">${s.titles} titles</span></div>
          <div class="bars">${s.genres.map((g, i) => `<div class="bar-row"><div><b>${esc(g.name)}</b><span>${g.loans} loans · ${g.titles} titles</span></div><div class="bar"><i style="--w:${(g.loans / maxGenre) * 100}%;--i:${i}"></i></div></div>`).join('')}</div>
          <div class="panel-head" style="margin:24px 0 0"><h3 style="font-size:18px">Waitlist</h3><span class="tag ${s.waitlist ? 'tag-warn' : 'tag-good'}">${s.waitlist} waiting</span></div></div>
      </div>`;
    wireChart(el, series);
  },

  async catalogue(el) {
    const data = await api('/api/admin/books');
    el.innerHTML = `${head('Catalogue', `${data.total} titles · ${data.items.reduce((a, b) => a + b.totalCopies, 0)} physical copies`, '<button class="btn btn-primary sm" id="addBook">+ Add title</button>')}
      <label class="search" style="max-width:420px"><input id="bq" placeholder="Filter titles…"></label>
      <div class="table-wrap" data-reveal><table><thead><tr><th>Title</th><th>Genre</th><th>Copies</th><th>Out</th><th>Waitlist</th><th>Rating</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.items.map((b) => `<tr data-id="${esc(b.id)}" data-text="${esc(`${b.title} ${b.author} ${b.category}`.toLowerCase())}">
        <td><div class="cell-book">${cover(b)}<div><b>${esc(b.title)}</b><small>${esc(b.author)}</small></div></div></td>
        <td>${esc(b.category)}</td><td>${b.totalCopies}</td><td>${b.onLoan}</td><td>${b.queue || '—'}</td><td>${b.rating ? `★ ${b.rating}` : '—'}</td>
        <td>${b.archived ? '<span class="tag tag-mute">Archived</span>' : b.available ? '<span class="tag tag-good">Available</span>' : '<span class="tag tag-warn">All out</span>'}</td>
        <td><div class="row-actions"><button class="mini" data-edit>Edit</button><button class="mini ${b.archived ? '' : 'danger'}" data-archive="${b.archived ? 0 : 1}">${b.archived ? 'Restore' : 'Archive'}</button></div></td></tr>`).join('')}</tbody></table></div>`;
    $('#bq', el).addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); el.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('hidden', !tr.dataset.text.includes(q))); });
    $('#addBook', el).onclick = () => bookForm(null, () => PANES.catalogue(el));
    el.querySelector('tbody').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const book = data.items.find((b) => b.id === tr?.dataset.id);
      if (!book) return;
      if (e.target.closest('[data-edit]')) bookForm(book, () => PANES.catalogue(el));
      const ar = e.target.closest('[data-archive]');
      if (ar) {
        const archive = ar.dataset.archive === '1';
        if (archive && !(await confirmDialog('Archive this title?', `“${book.title}” will be hidden from members. Active loans are unaffected.`, { confirm: 'Archive', danger: true }))) return;
        try { await api(`/api/admin/books/${book.id}`, { method: 'PATCH', body: { archived: archive } }); toast(archive ? 'Title archived.' : 'Title restored.'); PANES.catalogue(el); } catch (err) { toast(err.message, 'error'); }
      }
    });
  },

  async members(el) {
    const list = await api('/api/admin/members');
    const isOwner = store.me.role === 'owner';
    el.innerHTML = `${head('Members', `${list.length} readers`)}
      <label class="search" style="max-width:420px"><input id="mq" placeholder="Search name or email…"></label>
      <div class="table-wrap" data-reveal><table><thead><tr><th>Member</th><th>Role</th><th>Credits</th><th>On loan</th><th>Total</th><th>Joined</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((m) => `<tr data-id="${esc(m.id)}" data-text="${esc(`${m.name} ${m.email}`.toLowerCase())}">
        <td><b>${esc(m.name)}</b><br><small class="muted">${esc(m.email)}</small></td><td>${roleTag(m.role)}</td><td><b>${m.credits}</b></td>
        <td>${m.activeLoans}${m.overdue ? ` <span class="tag tag-bad">${m.overdue} late</span>` : ''}</td><td>${m.totalLoans}</td><td>${fmtDate(m.createdAt)}</td>
        <td>${m.status === 'active' ? '<span class="tag tag-good">Active</span>' : '<span class="tag tag-bad">Suspended</span>'}</td>
        <td><div class="row-actions">${m.id === store.me.id ? '<small class="muted">You</small>' : `<button class="mini" data-credits>Credits</button>
          <select class="mini" data-role aria-label="Role">${['member', 'admin', ...(isOwner ? ['owner'] : [])].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <button class="mini ${m.status === 'active' ? 'danger' : ''}" data-status>${m.status === 'active' ? 'Suspend' : 'Reactivate'}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
    $('#mq', el).addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); el.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('hidden', !tr.dataset.text.includes(q))); });
    const patch = async (id, body, msg) => { try { await api(`/api/admin/members/${id}`, { method: 'PATCH', body }); toast(msg); PANES.members(el); } catch (err) { toast(err.message, 'error'); PANES.members(el); } };
    el.querySelector('tbody').addEventListener('change', (e) => { const s = e.target.closest('[data-role]'); if (s) patch(s.closest('tr').dataset.id, { role: s.value }, `Role changed to ${s.value}.`); });
    el.querySelector('tbody').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const m = list.find((x) => x.id === tr.dataset.id);
      if (e.target.closest('[data-status]')) {
        const suspend = m.status === 'active';
        if (suspend && !(await confirmDialog(`Suspend ${m.name}?`, 'They will be signed out and unable to borrow until reactivated.', { confirm: 'Suspend', danger: true }))) return;
        patch(m.id, { status: suspend ? 'suspended' : 'active' }, suspend ? 'Member suspended.' : 'Member reactivated.');
      }
      if (e.target.closest('[data-credits]')) {
        const md = modal(`<h2>Adjust <em>credits</em></h2><p class="lead">${esc(m.name)} has ${m.credits} credits.</p>
          <form class="form" id="cf"><label class="field">Change (use negative to remove)<input name="creditDelta" type="number" min="-100" max="100" value="1"></label>
          <label class="field">Reason<input name="reason" maxlength="60" placeholder="e.g. Book donation reward"></label><div class="form-error" id="cfe"></div><button class="btn btn-primary">Apply</button></form>`);
        $('#cf', md.el).addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const d = Object.fromEntries(new FormData(ev.currentTarget));
          try { await api(`/api/admin/members/${m.id}`, { method: 'PATCH', body: { creditDelta: Number(d.creditDelta), reason: d.reason } }); toast('Credits updated.'); md.close(); PANES.members(el); if (m.id === store.me.id) refreshMe(); } catch (err) { $('#cfe', md.el).textContent = err.message; }
        });
      }
    });
  },

  async circulation(el, status = 'active') {
    const [loans, holds] = await Promise.all([api(`/api/admin/loans?status=${status}`), api('/api/admin/reservations')]);
    el.innerHTML = `${head('Circulation', 'Check returned copies in, chase overdue loans and watch the waitlist.')}
      <div class="chips">${['active', 'overdue', 'returned', 'all'].map((s) => `<button class="chip ${s === status ? 'active' : ''}" data-s="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
      <div class="table-wrap" data-reveal><table><thead><tr><th>Book</th><th>Member</th><th>Borrowed</th><th>Due</th><th>Status</th><th></th></tr></thead>
      <tbody>${loans.length ? loans.map((l) => `<tr><td><b>${esc(l.title)}</b></td><td>${esc(l.member)}<br><small class="muted">${esc(l.email)}</small></td><td>${fmtDate(l.borrowedAt)}</td><td>${fmtDate(l.dueAt)}</td>
        <td>${l.status === 'returned' ? `<span class="tag tag-mute">Returned ${fmtShort(l.returnedAt)}</span>` : l.overdue ? '<span class="tag tag-bad">Overdue</span>' : '<span class="tag tag-good">On loan</span>'}</td>
        <td><div class="row-actions">${l.status === 'active' ? `<button class="mini" data-checkin="${esc(l.id)}">Check in</button>` : ''}</div></td></tr>`).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:40px">Nothing here.</td></tr>'}</tbody></table></div>
      <div class="card panel" data-reveal><div class="panel-head"><h3>Waitlist & holds</h3><span class="tag tag-mute">${holds.length}</span></div>
        ${holds.length ? `<div class="table-wrap"><table><thead><tr><th>Book</th><th>Member</th><th>Joined</th><th>Status</th></tr></thead><tbody>${holds.map((h) => `<tr><td>${esc(h.title)}</td><td>${esc(h.member)}</td><td>${relTime(h.createdAt)}</td><td>${h.status === 'ready' ? `<span class="tag tag-good">Held until ${fmtShort(h.expiresAt)}</span>` : '<span class="tag tag-info">Waiting</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No one is waiting right now.</p>'}</div>`;
    el.querySelector('.chips').addEventListener('click', (e) => { const c = e.target.closest('[data-s]'); if (c) PANES.circulation(el, c.dataset.s).then(() => reveal(el)); });
    el.querySelector('tbody').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-checkin]'); if (!b) return;
      try { await api(`/api/admin/loans/${b.dataset.checkin}/checkin`, { method: 'POST', body: {} }); toast('Copy checked in — credit returned to member.'); PANES.circulation(el, status).then(() => reveal(el)); } catch (err) { toast(err.message, 'error'); }
    });
  },

  async developers(el) {
    const [keys, hooks, spec] = await Promise.all([api('/api/admin/api-keys'), api('/api/admin/webhooks'), api('/api/openapi.json')]);
    const partner = Object.entries(spec.paths).flatMap(([p, ms]) => Object.entries(ms).map(([m, o]) => ({ p, m: m.toUpperCase(), ...o }))).filter((e) => e['x-access'] === 'partner');
    el.innerHTML = `<div class="dev-root" style="display:grid;gap:24px">${head('API & <em>webhooks</em>', 'Connect your platform: provision members, grant credits, import catalogues and receive real-time events.', '<a class="btn btn-ghost sm" href="/api/openapi.json" target="_blank" rel="noopener">OpenAPI JSON</a>')}
      <div class="card panel" data-reveal><div class="panel-head"><h3>API keys</h3><button class="btn btn-primary sm" id="newKey">+ New key</button></div>
        ${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${keys.map((k) => `<tr><td><b>${esc(k.name)}</b></td><td><code>${esc(k.prefix)}…</code></td><td>${fmtDate(k.createdAt)}</td><td>${k.lastUsedAt ? relTime(k.lastUsedAt) : '—'}</td>
          <td><div class="row-actions">${k.revokedAt ? '<span class="tag tag-mute">Revoked</span>' : `<button class="mini danger" data-revoke="${esc(k.id)}">Revoke</button>`}</div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No keys yet. Create one to start integrating.</p>'}</div>
      <div class="card panel" data-reveal><div class="panel-head"><h3>Webhooks</h3><button class="btn btn-primary sm" id="newHook">+ Add endpoint</button></div>
        ${hooks.length ? `<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Events</th><th>Deliveries</th><th></th></tr></thead><tbody>${hooks.map((h) => `<tr><td><code>${esc(h.url)}</code></td><td><code>${esc(h.events)}</code></td><td><span class="tag tag-good">${h.delivered} ok</span> ${h.failed ? `<span class="tag tag-bad">${h.failed} failed</span>` : ''}</td>
          <td><div class="row-actions"><button class="mini" data-test="${esc(h.id)}">Send test</button><button class="mini" data-log="${esc(h.id)}">Log</button><button class="mini danger" data-del="${esc(h.id)}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Events: loan.created, loan.returned, loan.renewed, loan.overdue, reservation.created, reservation.ready, reservation.expired, ping.</p>'}</div>
      <div class="card panel" data-reveal><div class="panel-head"><h3>Partner endpoints</h3><span class="tag tag-mute">Authorization: Bearer osk_…</span></div>
        ${partner.map((e) => `<div class="endpoint"><span class="method ${e.m}">${e.m}</span><div><code>${esc(e.p)}</code><small>${esc(e.summary)}</small></div></div>`).join('')}</div></div>`;
    const refresh = () => PANES.developers(el).then(() => reveal(el));
    $('#newKey', el).onclick = () => {
      const md = modal(`<h2>New <em>API key</em></h2><p class="lead">Give it a name you will recognise, like “Campus portal (prod)”.</p>
        <form class="form" id="kf"><label class="field">Key name<input name="name" required maxlength="60"></label><div class="form-error" id="kfe"></div><button class="btn btn-primary">Create key</button></form>`);
      $('#kf', md.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const k = await api('/api/admin/api-keys', { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) });
          md.el.querySelector('form').outerHTML = `<p class="lead">Copy this key now — it will not be shown again.</p><div class="secret"><code>${esc(k.key)}</code><button class="mini btn-soft btn sm" id="cp">Copy</button></div>`;
          $('#cp', md.el).onclick = () => copyText(k.key);
          refresh();
        } catch (err) { $('#kfe', md.el).textContent = err.message; }
      });
    };
    $('#newHook', el).onclick = () => {
      const md = modal(`<h2>Add <em>webhook</em></h2><p class="lead">We POST signed JSON events to this URL. Verify the <code>X-OpenShelf-Signature</code> header with your secret.</p>
        <form class="form" id="hf"><label class="field">Endpoint URL<input name="url" required placeholder="https://partner.example.com/hooks/openshelf"></label>
        <label class="field">Events (comma separated, or *)<input name="events" value="*"></label><div class="form-error" id="hfe"></div><button class="btn btn-primary">Add endpoint</button></form>`);
      $('#hf', md.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const h = await api('/api/admin/webhooks', { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) });
          md.el.querySelector('form').outerHTML = `<p class="lead">Signing secret — store it safely, it will not be shown again.</p><div class="secret"><code>${esc(h.secret)}</code><button class="btn btn-soft sm" id="cp">Copy</button></div>`;
          $('#cp', md.el).onclick = () => copyText(h.secret);
          refresh();
        } catch (err) { $('#hfe', md.el).textContent = err.message; }
      });
    };
    $('.dev-root', el).addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return;
      try {
        if (t.dataset.revoke && await confirmDialog('Revoke this key?', 'Integrations using it will stop working immediately.', { confirm: 'Revoke', danger: true })) { await api(`/api/admin/api-keys/${t.dataset.revoke}`, { method: 'DELETE' }); toast('Key revoked.'); refresh(); }
        if (t.dataset.del && await confirmDialog('Delete webhook?', 'No more events will be sent to this endpoint.', { confirm: 'Delete', danger: true })) { await api(`/api/admin/webhooks/${t.dataset.del}`, { method: 'DELETE' }); toast('Webhook deleted.'); refresh(); }
        if (t.dataset.test) { await api(`/api/admin/webhooks/${t.dataset.test}/test`, { method: 'POST', body: {} }); toast('Test event sent — check the log in a moment.'); setTimeout(refresh, 1500); }
        if (t.dataset.log) {
          const log = await api(`/api/admin/webhooks/${t.dataset.log}/deliveries`);
          modal(`<h2>Delivery <em>log</em></h2><div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Event</th><th>Result</th><th>Code</th><th>Time</th><th>When</th></tr></thead><tbody>${log.map((d) => `<tr><td><code>${esc(d.event)}</code></td><td>${d.status === 'delivered' ? '<span class="tag tag-good">delivered</span>' : '<span class="tag tag-bad">failed</span>'}</td><td>${d.responseCode ?? '—'}</td><td>${d.durationMs}ms</td><td>${relTime(d.createdAt)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No deliveries yet.</td></tr>'}</tbody></table></div>`, { wide: true });
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  },

  async settings(el) {
    const t = await api('/api/admin/settings');
    const swatches = ['#f4b860', '#ff7a59', '#5fe0a5', '#8fa8ff', '#e05f8a', '#4fb3d9', '#c9a2ff', '#ffd166'];
    el.innerHTML = `${head('Library <em>settings</em>', 'Branding and lending rules. Changes apply instantly for every member — this is how partners white-label the platform.')}
      <div class="card panel" data-reveal><form class="form" id="sf" style="max-width:560px">
        <label class="field">Library name<input name="name" value="${esc(t.name)}" maxlength="60"></label>
        <div class="field">Brand colour<div class="swatches">${swatches.map((c) => `<button type="button" data-c="${c}" class="${c === t.brand_color ? 'active' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}<input type="color" name="brandColor" value="${esc(t.brand_color)}" style="width:44px;height:36px;border-radius:10px"></div></div>
        <div class="field-row"><label class="field">Loan length (days)<input name="loanDays" type="number" min="1" max="120" value="${t.loan_days}"></label>
          <label class="field">Welcome credits<input name="welcomeCredits" type="number" min="0" max="50" value="${t.welcome_credits}"></label></div>
        <div class="field">Plan <span class="tag tag-warn" style="justify-self:start">${esc(t.plan)}</span></div>
        <div class="form-error" id="sfe"></div><button class="btn btn-primary" style="justify-self:start">Save settings</button></form></div>`;
    const color = el.querySelector('[name=brandColor]');
    el.querySelector('.swatches').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; color.value = b.dataset.c; applyBrand(b.dataset.c); el.querySelectorAll('.swatches button').forEach((x) => x.classList.toggle('active', x === b)); });
    color.addEventListener('input', () => applyBrand(color.value));
    $('#sf', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.currentTarget));
      try {
        const nt = await api('/api/admin/settings', { method: 'PATCH', body: { ...d, loanDays: Number(d.loanDays), welcomeCredits: Number(d.welcomeCredits) } });
        store.set({ tenant: { ...store.tenant, name: nt.name, brandColor: nt.brand_color, loanDays: nt.loan_days, welcomeCredits: nt.welcome_credits } });
        toast('Settings saved.');
      } catch (err) { $('#sfe', el).textContent = err.message; }
    });
  },

  async audit(el) {
    const rows = await api('/api/admin/audit');
    el.innerHTML = `${head('Audit <em>log</em>', 'Every staff, member and API action that changes data.')}
      <div class="table-wrap" data-reveal><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
      <tbody>${rows.map((a) => `<tr><td>${relTime(a.createdAt)}</td><td>${esc(a.actor)}</td><td><code>${esc(a.action)}</code></td><td><code class="muted">${esc((a.target || '').slice(0, 8))}</code></td><td><small class="muted">${esc(Object.entries(a.meta).map(([k, v]) => `${k}: ${v}`).join(' · '))}</small></td></tr>`).join('') || '<tr><td colspan="5" class="muted" style="text-align:center;padding:40px">No events yet.</td></tr>'}</tbody></table></div>`;
  },

  async tenants(el) {
    const list = await api('/api/admin/tenants');
    el.innerHTML = `${head('White-label <em>tenants</em>', 'Every partner library running on this platform.', '<button class="btn btn-primary sm" id="newTenant">+ New tenant</button>')}
      <div class="table-wrap" data-reveal><table><thead><tr><th>Library</th><th>Slug</th><th>Plan</th><th>Members</th><th>Titles</th><th>Loans</th><th>Created</th></tr></thead>
      <tbody>${list.map((t) => `<tr><td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${esc(t.brand_color)};margin-right:8px"></span><b>${esc(t.name)}</b></td><td><code>${esc(t.slug)}</code></td><td><span class="tag tag-mute">${esc(t.plan)}</span></td><td>${t.members}</td><td>${t.titles}</td><td>${t.loans}</td><td>${fmtDate(t.created_at)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Members reach a tenant via its subdomain (<code>slug.yourdomain.com</code>) or the <code>X-Tenant</code> header. Each tenant manages its own catalogue, keys and webhooks.</p>`;
    $('#newTenant', el).onclick = () => {
      const md = modal(`<h2>New <em>tenant</em></h2><p class="lead">Provision a branded library for a partner.</p>
        <form class="form" id="tf"><label class="field">Name<input name="name" required maxlength="60" placeholder="City University Library"></label>
        <label class="field">Slug<input name="slug" required maxlength="40" placeholder="city-uni"></label>
        <div class="field-row"><label class="field">Plan<select name="plan"><option>starter</option><option selected>growth</option><option>enterprise</option></select></label><label class="field">Brand colour<input type="color" name="brandColor" value="#8fa8ff"></label></div>
        <div class="form-error" id="tfe"></div><button class="btn btn-primary">Create tenant</button></form>`);
      $('#tf', md.el).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/api/admin/tenants', { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) }); toast('Tenant created.'); md.close(); PANES.tenants(el).then(() => reveal(el)); } catch (err) { $('#tfe', md.el).textContent = err.message; }
      });
    };
  },
};

function bookForm(book, done) {
  const b = book || { title: '', author: '', category: 'Fiction', condition: 'Good', description: '', cover: '', isbn: '', totalCopies: 1 };
  const coverField = book && book.cover.includes('covers.openlibrary.org') ? '' : b.cover;
  const md = modal(`<h2>${book ? 'Edit' : 'Add a'} <em>title</em></h2><p class="lead">Add the ISBN and we will fetch the cover automatically.</p>
    <form class="form" id="bf">
      <label class="field">Title<input name="title" required maxlength="150" value="${esc(b.title)}"></label>
      <div class="field-row"><label class="field">Author<input name="author" required maxlength="100" value="${esc(b.author)}"></label><label class="field">ISBN<input name="isbn" maxlength="17" value="${esc(b.isbn || '')}"></label></div>
      <div class="field-row"><label class="field">Genre<input name="category" maxlength="40" value="${esc(b.category)}" list="genres"></label>
        <label class="field">Copies<input name="totalCopies" type="number" min="0" max="999" value="${b.totalCopies}"></label></div>
      <datalist id="genres">${['Fiction', 'Non-fiction', 'Classics', 'Personal growth', 'Memoir', 'Children', 'Sci-fi & fantasy', 'Poetry'].map((g) => `<option>${g}</option>`).join('')}</datalist>
      <label class="field">Condition<select name="condition">${['Like new', 'Good', 'Well-loved'].map((c) => `<option ${c === b.condition ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field">Cover image URL (optional, HTTPS)<input name="cover" type="url" value="${esc(coverField)}"></label>
      <label class="field">Description<textarea name="description" maxlength="1000">${esc(b.description)}</textarea></label>
      <div class="form-error" id="bfe"></div><button class="btn btn-primary">${book ? 'Save changes' : 'Add to catalogue'}</button></form>`);
  $('#bf', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget));
    d.totalCopies = Number(d.totalCopies);
    try {
      await api(book ? `/api/admin/books/${book.id}` : '/api/admin/books', { method: book ? 'PATCH' : 'POST', body: d });
      toast(book ? 'Title updated.' : 'Title added to the catalogue.');
      md.close();
      done();
    } catch (err) { $('#bfe', md.el).textContent = err.message; }
  });
}
