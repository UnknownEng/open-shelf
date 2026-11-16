// Motion & effects: ambient sky, spotlight, reveal, tilt, magnetic buttons,
// count-ups, typewriter, flying covers and confetti. All honour reduced motion.
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------- ambient sky (canvas motes)
export function initSky(canvas) {
  if (!canvas || reduced) return;
  const ctx = canvas.getContext('2d');
  let w, h, dpr, motes = [];
  const mouse = { x: -999, y: -999 };
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.width = innerWidth * dpr;
    h = canvas.height = innerHeight * dpr;
    const count = Math.round(Math.min(90, (innerWidth * innerHeight) / 16000));
    motes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: (Math.random() * 1.6 + .4) * dpr,
      vy: -(Math.random() * .25 + .05) * dpr, vx: (Math.random() - .5) * .15 * dpr,
      t: Math.random() * Math.PI * 2, hue: Math.random(),
    }));
  };
  resize();
  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; }, { passive: true });
  let colors = [];
  const refreshColors = () => { colors = [css('--accent') || '#f4b860', css('--accent-3') || '#8fa8ff', css('--accent-2') || '#ff7a59']; };
  refreshColors();
  new MutationObserver(refreshColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  const frame = () => {
    if (!document.hidden) {
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.t += 0.02; m.x += m.vx + Math.sin(m.t) * .12; m.y += m.vy;
        const dx = m.x - mouse.x, dy = m.y - mouse.y, d2 = dx * dx + dy * dy, R = 140 * dpr;
        if (d2 < R * R) { const f = (1 - Math.sqrt(d2) / R) * 1.6; m.x += (dx / Math.sqrt(d2 || 1)) * f; m.y += (dy / Math.sqrt(d2 || 1)) * f; }
        if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
        if (m.x < -10) m.x = w + 10; if (m.x > w + 10) m.x = -10;
        const a = .35 + Math.sin(m.t * 1.5) * .3;
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = colors[m.hue < .6 ? 0 : m.hue < .85 ? 1 : 2];
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = Math.max(0, a * .18);
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  };
  frame();
}

// ---------------------------------------------------------------- pointer-driven effects
export function initPointerFx() {
  const root = document.documentElement;
  let raf = 0, px = 0, py = 0;
  addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      root.style.setProperty('--cx', `${px}px`);
      root.style.setProperty('--cy', `${py}px`);
      const scene = document.querySelector('.scene-inner');
      if (scene && !reduced) {
        scene.style.setProperty('--mx', ((px / innerWidth) - .5).toFixed(3));
        scene.style.setProperty('--my', ((py / innerHeight) - .5).toFixed(3));
      }
    });
  }, { passive: true });

  if (!finePointer || reduced) return;
  // 3D tilt + glare on book cards
  document.addEventListener('pointermove', (e) => {
    const tilt = e.target.closest?.('.book-card .tilt');
    if (tilt) {
      const r = tilt.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      tilt.style.setProperty('--ry', `${(x - .5) * 22}deg`);
      tilt.style.setProperty('--rx', `${(.5 - y) * 18}deg`);
      tilt.style.setProperty('--gx', `${x * 100}%`);
      tilt.style.setProperty('--gy', `${y * 100}%`);
    }
    const tile = e.target.closest?.('.tile');
    if (tile) {
      const r = tile.getBoundingClientRect();
      tile.style.setProperty('--px', `${e.clientX - r.left}px`);
      tile.style.setProperty('--py', `${e.clientY - r.top}px`);
    }
    const mag = e.target.closest?.('.magnetic');
    if (mag) {
      const r = mag.getBoundingClientRect();
      mag.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .25}px, ${(e.clientY - r.top - r.height / 2) * .35}px)`;
    }
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    const tilt = e.target.closest?.('.book-card .tilt');
    if (tilt && !tilt.contains(e.relatedTarget)) { tilt.style.setProperty('--rx', '0deg'); tilt.style.setProperty('--ry', '0deg'); }
    const mag = e.target.closest?.('.magnetic');
    if (mag && !mag.contains(e.relatedTarget)) mag.style.transform = '';
  });
}

// ---------------------------------------------------------------- pause off-screen animation
let pauseIo;
/** Stops CSS animations inside zones that are scrolled out of view (saves CPU/battery). */
export function pauseOffscreen(root = document) {
  pauseIo ||= new IntersectionObserver((entries) => {
    for (const en of entries) en.target.classList.toggle('offscreen', !en.isIntersecting);
  }, { rootMargin: '120px 0px' });
  root.querySelectorAll('.hero, .ticker, .marquee, .bento, .steps, .platforms, .cta-band, .brand-mark').forEach((el) => pauseIo.observe(el));
}

// ---------------------------------------------------------------- scroll reveal + count-up
let io;
export function reveal(root = document) {
  io ||= new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add('in');
      en.target.querySelectorAll?.('[data-count]').forEach(countUp);
      if (en.target.matches('[data-count]')) countUp(en.target);
      if (en.target._onReveal) en.target._onReveal();
      io.unobserve(en.target);
    }
  }, { threshold: 0.01, rootMargin: '0px 0px -8% 0px' });
  root.querySelectorAll('[data-reveal], [data-count]:not([data-reveal] [data-count])').forEach((el) => io.observe(el));
}

export function countUp(el) {
  if (el._counted) return;
  el._counted = true;
  const target = Number(el.dataset.count) || 0;
  const suffix = el.dataset.suffix || '';
  const decimals = Number(el.dataset.decimals || 0);
  if (reduced) { el.textContent = target.toFixed(decimals) + suffix; return; }
  const start = performance.now(), dur = 1600;
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 4);
    el.textContent = (target * e).toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function splitWords(el) {
  let i = 0;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(part); return; }
          const outer = document.createElement('span');
          outer.className = 'split-word';
          const inner = document.createElement('span');
          inner.style.setProperty('--w', i++);
          inner.textContent = part;
          outer.append(inner);
          frag.append(outer);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === 1 && child.tagName !== 'BR') walk(child);
    }
  };
  walk(el);
}

// ---------------------------------------------------------------- typewriter
export function typewriter(el, segments, speed = 14) {
  el.innerHTML = '';
  const caret = document.createElement('span');
  caret.className = 'caret';
  if (reduced) {
    for (const [cls, text] of segments) { const s = document.createElement('span'); s.className = cls; s.textContent = text; el.append(s); }
    el.append(caret);
    return;
  }
  let si = 0, ci = 0, span = null;
  el.append(caret);
  const tick = () => {
    if (!el.isConnected) return;
    if (si >= segments.length) return;
    const [cls, text] = segments[si];
    if (!span) { span = document.createElement('span'); span.className = cls; el.insertBefore(span, caret); }
    span.textContent += text[ci++];
    if (ci >= text.length) { si++; ci = 0; span = null; }
    setTimeout(tick, text[ci - 1] === '\n' ? speed * 8 : speed + Math.random() * speed);
  };
  tick();
}

// ---------------------------------------------------------------- flying cover → shelf
function visibleTarget() {
  for (const sel of ['#shelfTarget', '#tabbar [data-tab="shelf"]', '#creditPill']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

export function flyToShelf(fromEl) {
  const target = visibleTarget();
  if (!fromEl || !target || reduced) return Promise.resolve();
  const a = fromEl.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const clone = fromEl.cloneNode(true);
  clone.classList.add('flying');
  Object.assign(clone.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`, margin: 0 });
  document.body.append(clone);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = clone.animate([
    { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * .35}px, ${dy * .35 - 180}px) rotate(-20deg) scale(.85)`, opacity: 1, offset: .4 },
    { transform: `translate(${dx}px, ${dy}px) rotate(-340deg) scale(.08)`, opacity: .4 },
  ], { duration: 1100, easing: 'cubic-bezier(.5,0,.3,1)' });
  return anim.finished.then(() => {
    clone.remove();
    target.classList.remove('bump'); void target.offsetWidth; target.classList.add('bump');
    confetti(b.left + b.width / 2, b.top + b.height / 2, 26);
  });
}

export function confetti(x, y, n = 40) {
  if (reduced) return;
  const colors = [css('--accent'), css('--accent-2'), css('--accent-3'), css('--good'), '#ffffff'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    p.style.background = colors[i % colors.length];
    document.body.append(p);
    const ang = Math.random() * Math.PI * 2, vel = 60 + Math.random() * 140;
    const tx = Math.cos(ang) * vel, ty = Math.sin(ang) * vel - 60;
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0)', opacity: 1 },
      { transform: `translate(${tx}px, ${ty + 160}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)' }).finished.then(() => p.remove());
  }
}
