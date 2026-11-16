'use strict';
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/**
 * Ordered schema migrations. PRAGMA user_version records how many have run.
 * Never edit a released migration — append a new one.
 */
const MIGRATIONS = [
  // 1 — original prototype schema (IF NOT EXISTS keeps old databases compatible)
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,city TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',credits INTEGER NOT NULL DEFAULT 3,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL,category TEXT NOT NULL,condition TEXT NOT NULL,description TEXT NOT NULL,cover TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS loans(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES books(id),user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL CHECK(status IN ('active','returned','cancelled')),borrowed_at TEXT NOT NULL,due_at TEXT NOT NULL,returned_at TEXT);
   CREATE TABLE IF NOT EXISTS credit_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),loan_id TEXT REFERENCES loans(id),delta INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memberships(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),plan TEXT NOT NULL DEFAULT 'reader',status TEXT NOT NULL DEFAULT 'active',started_at TEXT NOT NULL);`,

  // 2 — multi-tenant platform: tenants, inventory, waitlists, reviews, notifications, partner API, webhooks, audit
  `CREATE TABLE tenants(
     id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     brand_color TEXT NOT NULL DEFAULT '#f4b860', plan TEXT NOT NULL DEFAULT 'starter',
     loan_days INTEGER NOT NULL DEFAULT 21, welcome_credits INTEGER NOT NULL DEFAULT 3,
     created_at TEXT NOT NULL);
   INSERT INTO tenants(id,slug,name,plan,created_at) VALUES('default','openshelf','Open Shelf','enterprise',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

   ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
   ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
   ALTER TABLE users ADD COLUMN last_login_at TEXT;
   ALTER TABLE users ADD COLUMN external_id TEXT;
   ALTER TABLE books ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
   ALTER TABLE books ADD COLUMN isbn TEXT;
   ALTER TABLE books ADD COLUMN total_copies INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE books ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE loans ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
   ALTER TABLE loans ADD COLUMN renewals INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE loans ADD COLUMN overdue_notified INTEGER NOT NULL DEFAULT 0;

   CREATE TABLE reservations(
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id),
     user_id TEXT NOT NULL REFERENCES users(id),
     status TEXT NOT NULL CHECK(status IN ('waiting','ready','fulfilled','cancelled','expired')),
     created_at TEXT NOT NULL, ready_at TEXT, expires_at TEXT);
   CREATE TABLE reviews(
     id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), user_id TEXT NOT NULL REFERENCES users(id),
     rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL, UNIQUE(book_id,user_id));
   CREATE TABLE notifications(
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', read_at TEXT, created_at TEXT NOT NULL);
   CREATE TABLE api_keys(
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
   CREATE TABLE webhooks(
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), url TEXT NOT NULL, secret TEXT NOT NULL,
     events TEXT NOT NULL DEFAULT '*', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
   CREATE TABLE webhook_deliveries(
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL,
     status TEXT NOT NULL, response_code INTEGER, duration_ms INTEGER, created_at TEXT NOT NULL);
   CREATE TABLE sso_tokens(
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL, used_at TEXT);
   CREATE TABLE audit_log(
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT, actor_label TEXT NOT NULL DEFAULT '',
     action TEXT NOT NULL, target TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);

   CREATE INDEX idx_books_tenant ON books(tenant_id, archived);
   CREATE INDEX idx_loans_book ON loans(book_id, status);
   CREATE INDEX idx_loans_user ON loans(user_id, status);
   CREATE INDEX idx_loans_tenant ON loans(tenant_id, status, borrowed_at);
   CREATE INDEX idx_res_book ON reservations(book_id, status, created_at);
   CREATE INDEX idx_res_user ON reservations(user_id, status);
   CREATE INDEX idx_notif_user ON notifications(user_id, read_at);
   CREATE INDEX idx_ledger_user ON credit_ledger(user_id, created_at);
   CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at);
   CREATE INDEX idx_users_tenant ON users(tenant_id);`,

  // 3 — optional second title (e.g. the Urdu title, printed on covers)
  `ALTER TABLE books ADD COLUMN alt_title TEXT;
   UPDATE tenants SET brand_color='#c8ff3d' WHERE id='default' AND brand_color='#f4b860';`,

  // 4 — one-time catalogue fix-ups for older databases (previously re-run on every boot), unique partner IDs
  (database) => {
    const { CATALOGUE } = require('./seed');
    database.exec(`UPDATE books SET isbn='9780143118527' WHERE id='b1' AND isbn='9780143426176';
                   UPDATE books SET isbn='9780307388179' WHERE id='b3' AND isbn='9788184001754';`);
    const fill = database.prepare("UPDATE books SET isbn=?, total_copies=?, cover='', category=? WHERE id=? AND isbn IS NULL");
    const urdu = database.prepare('UPDATE books SET alt_title=? WHERE id=? AND alt_title IS NULL');
    for (const [bookId, , , category, , isbn, copies, , alt] of CATALOGUE) {
      if (isbn) fill.run(isbn, copies, category, bookId);
      if (alt) urdu.run(alt, bookId);
    }
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users(tenant_id, external_id) WHERE external_id IS NOT NULL;');
  },
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db); else db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${v + 1} failed: ${err.message}`);
    }
  }
}

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
const one = (sql, ...p) => stmt(sql).get(...clean(p)) || null;
const all = (sql, ...p) => stmt(sql).all(...clean(p));
const run = (sql, ...p) => stmt(sql).run(...clean(p));

let depth = 0;
/** Run fn inside a write transaction. node:sqlite is synchronous, so nothing can interleave. */
function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

const now = () => new Date().toISOString();
const id = () => require('node:crypto').randomUUID();

module.exports = { db, migrate, one, all, run, tx, now, id };
