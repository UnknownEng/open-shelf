'use strict';
/**
 * Vercel serverless entry. Vercel has no persistent disk, so this runs as a
 * self-seeding live demo: SQLite lives in /tmp and is re-seeded on cold start.
 * For real persistent data, point the app at a hosted database (see README).
 */
process.env.DB_PATH ||= '/tmp/openshelf.sqlite';
process.env.TRUST_PROXY ||= '1';

const { seedDemo } = require('../server/demo');
if (process.env.DEMO_MODE !== '0') {
  // Passwords written in the source code must never unlock the public site.
  // Set DEMO_ADMIN_PASSWORD / DEMO_READER_PASSWORD in Vercel; otherwise both demo accounts are locked with random passwords.
  const random = () => require('node:crypto').randomBytes(24).toString('base64url');
  if (!process.env.DEMO_ADMIN_PASSWORD) console.warn('DEMO_ADMIN_PASSWORD is not set: the demo admin account is locked.');
  seedDemo({ adminPassword: process.env.DEMO_ADMIN_PASSWORD || random(), readerPassword: process.env.DEMO_READER_PASSWORD || random() });
}

const { handler } = require('../server/index');
module.exports = handler;
