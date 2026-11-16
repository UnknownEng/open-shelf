'use strict';
const crypto = require('node:crypto');
const { one, all, run, now, id } = require('./db');
const { assertPublicUrl } = require('./netguard');

/** In-app notification for a member. */
function notify(userId, kind, title, body = '') {
  run('INSERT INTO notifications(id,user_id,kind,title,body,created_at) VALUES(?,?,?,?,?,?)', id(), userId, kind, title, body, now());
}

/** Immutable audit trail of who did what — required by most enterprise buyers. */
function audit(tenantId, actor, action, target, meta = {}) {
  run('INSERT INTO audit_log(id,tenant_id,actor_id,actor_label,action,target,meta,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id(), tenantId, actor?.id || null, actor?.label || actor?.email || actor?.name || 'system', action, target || null, JSON.stringify(meta), now());
}

/**
 * Deliver an event to every subscribed webhook for the tenant.
 * Signed with HMAC-SHA256 so receivers can verify authenticity.
 * Fire-and-forget: never blocks or fails the originating request.
 */
function emit(tenantId, event, data) {
  const hooks = all('SELECT * FROM webhooks WHERE tenant_id=? AND active=1', tenantId)
    .filter((h) => h.events === '*' || h.events.split(',').map((s) => s.trim()).includes(event));
  for (const hook of hooks) {
    const p = deliver(hook, event, data);
    // On Vercel, keep the function alive until delivery completes (what @vercel/functions' waitUntil does).
    try { globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(p); } catch { /* not on Vercel */ }
  }
}

async function deliver(hook, event, data) {
  const body = JSON.stringify({ id: id(), event, createdAt: now(), data });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  const started = Date.now();
  let status = 'failed', code = null;
  try {
    await assertPublicUrl(hook.url); // re-checked at send time (defeats DNS rebinding)
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenShelf-Webhooks/1.0', 'X-OpenShelf-Event': event, 'X-OpenShelf-Signature': `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    code = res.status;
    status = res.ok ? 'delivered' : 'failed';
  } catch { /* network error or timeout */ }
  try {
    if (one('SELECT id FROM webhooks WHERE id=?', hook.id)) {
      run('INSERT INTO webhook_deliveries(id,webhook_id,event,status,response_code,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
        id(), hook.id, event, status, code, Date.now() - started, now());
    }
  } catch { /* database closed during shutdown */ }
}

module.exports = { notify, audit, emit };
