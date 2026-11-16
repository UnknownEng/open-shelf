'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const config = require('./config');
const { db, migrate, one } = require('./db');
const { HttpError, sendJson, readBody, clientIp, SECURITY_HEADERS } = require('./http');
const { Router } = require('./router');
const { limit } = require('./ratelimit');
const { userFromRequest, apiKeyFromRequest } = require('./auth');
const { seedCatalogue } = require('./seed');
const { runJobs } = require('./services/library');

migrate();
seedCatalogue();

// ---------------------------------------------------------------- CLI
const [cmd, arg1, arg2] = process.argv.slice(2);
if (require.main === module && cmd === 'make-admin') {
  const email = String(arg1 || '').trim().toLowerCase();
  const role = arg2 === 'owner' ? 'owner' : 'admin';
  if (!email) { console.error('Usage: npm run make-admin -- reader@example.com [owner]'); process.exit(1); }
  const res = db.prepare('UPDATE users SET role=? WHERE email=?').run(role, email);
  if (!res.changes) { console.error('No account found for that email. Register in the app first.'); process.exit(1); }
  console.log(`${email} is now ${role === 'owner' ? 'a platform owner' : 'a library admin'}.`);
  process.exit(0);
}

// ---------------------------------------------------------------- routes
const router = new Router();
require('./routes/public')(router);
require('./routes/admin')(router);
require('./routes/partner')(router);

router.get('/api/openapi.json', { summary: 'OpenAPI 3.1 description of this API', tag: 'System' }, (ctx) => {
  const paths = {};
  const staff = ['admin', 'owner'].includes(ctx.user?.role);
  for (const r of router.routes) {
    if (!staff && (r.auth === 'admin' || r.auth === 'owner')) continue; // staff-only routes are listed for staff only
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    paths[p] = paths[p] || {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary || '',
      tags: [r.tag || 'Other'],
      security: r.auth === 'partner' ? [{ apiKey: [] }] : r.auth ? [{ session: [] }] : [],
      'x-access': r.auth || 'public',
      parameters: r.keys.map((k) => ({ name: k, in: 'path', required: true, schema: { type: 'string' } })),
      responses: { 200: { description: 'Success' }, 400: { description: 'Validation error' }, 401: { description: 'Not authenticated' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Open Shelf API', version: config.VERSION, description: 'Credit-based lending platform. Partner endpoints (/api/v1) use Bearer API keys created in the admin console.' },
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'shelf_session' }, apiKey: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
});

function resolveTenant(req) {
  const slug = String(req.headers['x-tenant'] || String(req.headers.host || '').split('.')[0] || '').toLowerCase();
  return (slug && one('SELECT * FROM tenants WHERE slug=?', slug)) || one("SELECT * FROM tenants WHERE id='default'");
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-site requests are not allowed.');
  }
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  const ctx = {
    req, res, url, ip, query: url.searchParams, params: {}, status: 200,
    headers: { 'X-Request-Id': crypto.randomUUID() },
    body: () => readBody(req),
    redirect(location) { ctx.status = 302; ctx.headers.Location = location; },
  };
  try {
    limit(`ip:${ip}`, 600, 60_000);
    const found = router.match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'Endpoint not found.');
    if (found.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
    if (found.badRequest) throw new HttpError(400, 'Malformed URL.');
    const { route, params } = found;
    ctx.params = params;

    if (route.auth === 'partner') {
      const key = apiKeyFromRequest(req);
      if (!key) throw new HttpError(401, 'Provide a valid API key: Authorization: Bearer osk_...');
      limit(`key:${key.id}`, 1200, 60_000);
      ctx.apiKey = key;
      ctx.tenant = one('SELECT * FROM tenants WHERE id=?', key.tenant_id);
    } else {
      const user = userFromRequest(req);
      ctx.user = user && user.status === 'active' ? user : null;
      ctx.tenant = ctx.user ? one('SELECT * FROM tenants WHERE id=?', ctx.user.tenant_id) : resolveTenant(req);
      if (req.method !== 'GET') checkOrigin(req);
      if (['user', 'admin', 'owner'].includes(route.auth) && !ctx.user) throw new HttpError(401, 'Please sign in to continue.', 'auth_required');
      if (route.auth === 'admin' && !['admin', 'owner'].includes(ctx.user.role)) throw new HttpError(403, 'Library staff access is required.');
      if (route.auth === 'owner' && ctx.user.role !== 'owner') throw new HttpError(403, 'Platform owner access is required.');
    }

    const data = await route.handler(ctx);
    if (ctx.status === 302) { res.writeHead(302, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...ctx.headers }); return res.end(); }
    if (data && typeof data.__raw === 'string') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': data.type, 'Content-Disposition': `attachment; filename="${data.filename}"`, ...ctx.headers });
      return res.end(data.__raw);
    }
    sendJson(res, ctx.status, data, ctx.headers);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.retryAfter) ctx.headers['Retry-After'] = String(err.retryAfter);
      return sendJson(res, err.status, { error: err.message, code: err.code }, ctx.headers);
    }
    console.error(`[${ctx.headers['X-Request-Id']}]`, err);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'server_error' }, ctx.headers);
  }
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "connect-src 'self'",
  "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');
const gzCache = new Map();

function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  let file = path.resolve(config.PUBLIC_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(config.PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  let stat;
  try { stat = fs.statSync(file); if (stat.isDirectory()) throw new Error('dir'); } catch {
    if (path.extname(pathname)) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    file = path.join(config.PUBLIC_DIR, 'index.html'); // SPA fallback
    stat = fs.statSync(file);
  }
  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type, ...SECURITY_HEADERS,
    'Cache-Control': 'no-cache', // revalidate every time; unchanged files return a cheap 304
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  if (req.headers['if-modified-since'] === headers['Last-Modified']) { res.writeHead(304, headers); return res.end(); }
  let body = fs.readFileSync(file);
  const compressible = /text|javascript|json|svg|manifest/.test(type);
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    const key = `${file}:${stat.mtimeMs}`;
    if (!gzCache.has(key)) gzCache.set(key, zlib.gzipSync(body));
    body = gzCache.get(key);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------- server
let lastJobs = 0;
function maybeRunJobs() {
  // Serverless platforms have no long-lived timers, so jobs also run opportunistically on traffic.
  if (Date.now() - lastJobs < config.JOB_INTERVAL_MS) return;
  lastJobs = Date.now();
  try { runJobs(); } catch (e) { console.error('job error', e); }
}

/** Plain (req, res) handler — used by the standalone server and by the Vercel function. */
function handler(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  maybeRunJobs();
  if (url.pathname.startsWith('/api/')) {
    if (process.env.LOG !== '0') res.on('finish', () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    return void handleApi(req, res, url);
  }
  try { serveStatic(req, res, url); } catch (err) { console.error(err); res.writeHead(500); res.end(); }
}

if (require.main === module) {
  const server = http.createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  setInterval(maybeRunJobs, config.JOB_INTERVAL_MS).unref();
  maybeRunJobs();
  server.listen(config.PORT, () => console.log(`Open Shelf ${config.VERSION} running at http://localhost:${config.PORT}`));
  const shutdown = () => {
    server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { handler, router };
