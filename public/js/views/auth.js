import { api, refreshMe, store } from '../api.js';
import { modal, toast, esc, $ } from '../ui.js';
import { confetti } from '../fx.js';

function strength(pw) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

/** Opens the sign-in / register modal. Resolves true once signed in. */
export function openAuth(mode = 'login') {
  return new Promise((resolve) => {
    let done = false;
    const welcome = store.tenant?.welcomeCredits ?? 3;
    const m = modal(`
      <div class="seg" data-mode="${mode}"><span class="seg-pill"></span>
        <button type="button" data-m="login">Sign in</button><button type="button" data-m="register">Create account</button>
      </div>
      <h2 id="authTitle"></h2>
      <p class="lead" id="authLead"></p>
      <form class="form" id="authForm" novalidate>
        <div class="field-row reg">
          <label class="field">Full name<input name="name" autocomplete="name" maxlength="70" placeholder="Your name"></label>
          <label class="field">City<input name="city" autocomplete="address-level2" maxlength="70" placeholder="Lahore"></label>
        </div>
        <label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
        <label class="field">Password<input name="password" type="password" required minlength="10" placeholder="At least 10 characters"></label>
        <div class="pw-meter reg"><i></i></div>
        <div class="form-error" id="authError"></div>
        <button class="btn btn-primary lg" type="submit" id="authSubmit"></button>
      </form>`, { onClose: () => { if (!done) resolve(false); } });

    const el = m.el;
    const seg = $('.seg', el);
    const setMode = (next) => {
      mode = next;
      seg.dataset.mode = mode;
      el.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
      el.querySelectorAll('.reg').forEach((r) => r.classList.toggle('hidden', mode === 'login'));
      $('#authTitle', el).innerHTML = mode === 'login' ? 'Welcome <em>back.</em>' : 'Start your <em>shelf.</em>';
      $('#authLead', el).textContent = mode === 'login' ? 'Sign in to borrow, return and manage your reading.' : `Create a free account — ${welcome} borrowing credits are on us.`;
      $('#authSubmit', el).innerHTML = `${mode === 'login' ? 'Sign in' : 'Create account'} <span class="arrow">↗</span>`;
      el.querySelector('[name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('#authError', el).textContent = '';
    };
    setMode(mode);
    el.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));

    const meter = $('.pw-meter i', el);
    el.querySelector('[name=password]').addEventListener('input', (e) => {
      const s = strength(e.target.value);
      meter.style.setProperty('--p', `${(s / 5) * 100}%`);
      meter.style.setProperty('--c', ['var(--bad)', 'var(--bad)', 'var(--warn)', 'var(--warn)', 'var(--good)', 'var(--good)'][s]);
    });

    $('#authForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget));
      const btn = $('#authSubmit', el);
      btn.disabled = true;
      try {
        await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: data });
        await refreshMe();
        done = true;
        const r = btn.getBoundingClientRect();
        confetti(r.left + r.width / 2, r.top, 50);
        toast(mode === 'login' ? `Welcome back, ${store.me.name.split(' ')[0]}!` : `Welcome to the library — ${store.me.credits} credits are ready.`);
        m.close();
        resolve(true);
      } catch (err) {
        $('#authError', el).textContent = err.message;
        el.querySelector('.modal-close').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 300 });
      } finally { btn.disabled = false; }
    });
  });
}
