'use strict';
const crypto = require('node:crypto');
const { one, run, now } = require('./db');
const { parseCookies } = require('./http');
const { SESSION_DAYS, PRODUCTION } = require('./config');

const COOKIE = 'shelf_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

// Used when the account does not exist so login timing does not reveal registered emails.
const DUMMY = hashPassword(token());

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || DUMMY).split(':');
  if (!salt || !hash || hash.length !== 128) {
    crypto.scryptSync(pw, Buffer.from(DUMMY.split(':')[0], 'hex'), 64);
    return false;
  }
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}

function createSession(userId) {
  const t = token();
  run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha256(t), userId, Date.now() + SESSION_DAYS * 86_400_000);
  run('UPDATE users SET last_login_at=? WHERE id=?', now(), userId);
  return t;
}

function sessionCookie(t, maxAge = SESSION_DAYS * 86_400) {
  return `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${PRODUCTION ? '; Secure' : ''}`;
}

const USER_SQL = `SELECT u.id,u.tenant_id,u.name,u.email,u.city,u.role,u.status,u.credits,u.created_at,u.external_id,
  COALESCE(m.plan,'reader') AS membership FROM users u LEFT JOIN memberships m ON m.user_id=u.id`;

function userFromRequest(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  return one(`${USER_SQL} JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`, sha256(t), Date.now());
}

function destroySession(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) run('DELETE FROM sessions WHERE token_hash=?', sha256(t));
}

function apiKeyFromRequest(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(osk_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const key = one('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL', sha256(m[1]));
  if (key) run('UPDATE api_keys SET last_used_at=? WHERE id=?', now(), key.id);
  return key;
}

function newApiKey() {
  const raw = `osk_${token(30)}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 12) };
}

const publicUser = (u) => u && {
  id: u.id, name: u.name, email: u.email, city: u.city, role: u.role, status: u.status,
  credits: u.credits, membership: u.membership || 'reader', createdAt: u.created_at, tenantId: u.tenant_id,
};

module.exports = {
  sha256, token, hashPassword, verifyPassword, createSession, sessionCookie, destroySession,
  userFromRequest, apiKeyFromRequest, newApiKey, publicUser, USER_SQL,
};
