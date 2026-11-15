'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Real environment variables always win.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* no .env file */ }

module.exports = Object.freeze({
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: Number(process.env.PORT || 3000),
  // `--demo` uses a separate database so sales-demo data never mixes with real members.
  DB_PATH: process.env.DB_PATH || path.join(ROOT, process.argv.includes('--demo') ? 'openshelf-demo.sqlite' : 'openshelf.sqlite'),
  PRODUCTION: process.env.NODE_ENV === 'production',
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  VERSION: require('../package.json').version,
  SESSION_DAYS: 30,
  SSO_TOKEN_MINUTES: 10,
  RESERVATION_HOLD_HOURS: 48,
  RENEW_DAYS: 14,
  MAX_RENEWALS: 1,
  JOB_INTERVAL_MS: Number(process.env.JOB_INTERVAL_MS || 60_000),
});
