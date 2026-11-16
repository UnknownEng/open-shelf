'use strict';
const { HttpError } = require('./http');

const fail = (msg) => { throw new HttpError(400, msg); };

function str(value, label, { min = 0, max = 500, optional = false } = {}) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (!v && optional) return '';
  if (v.length < Math.max(min, optional ? 0 : 1)) fail(`${label} is required${min > 1 ? ` (at least ${min} characters)` : ''}.`);
  if (v.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return v;
}

function int(value, label, { min = -Infinity, max = Infinity, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`${label} must be a whole number.`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
  return n;
}

function email(value) {
  const v = str(value, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) fail('Enter a valid email address.');
  return v;
}

function password(value) {
  const v = String(value || '');
  if (v.length < 10) fail('Password must be at least 10 characters.');
  if (v.length > 200) fail('Password is too long.');
  return v;
}

function oneOf(value, label, options, fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (!options.includes(value)) fail(`${label} must be one of: ${options.join(', ')}.`);
  return value;
}

function httpsUrl(value, label, { optional = true, allowLocalHttp = false } = {}) {
  const v = str(value, label, { max: 600, optional });
  if (!v) return '';
  let u;
  try { u = new URL(v); } catch { fail(`${label} must be a valid URL.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocalHttp && local && u.protocol === 'http:')) fail(`${label} must use HTTPS.`);
  return u.href;
}

function color(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail('Brand colour must be a hex value like #f4b860.');
  return value.toLowerCase();
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}

module.exports = { str, int, email, password, oneOf, httpsUrl, color, bool, fail };
