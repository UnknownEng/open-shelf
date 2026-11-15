// Thin API client + tiny shared store.
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

const listeners = new Set();
export const store = {
  me: null,
  unread: 0,
  tenant: null,
  set(patch) { Object.assign(this, patch); listeners.forEach((fn) => fn(this)); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  get isStaff() { return ['admin', 'owner'].includes(this.me?.role); },
};

export async function refreshMe() {
  try {
    const { user, unread } = await api('/api/me');
    store.set({ me: user, unread });
  } catch { store.set({ me: null, unread: 0 }); }
  return store.me;
}

/** Broadcast that library state changed (borrow/return/etc.) so views can refresh. */
export const changed = () => window.dispatchEvent(new CustomEvent('library:changed'));
