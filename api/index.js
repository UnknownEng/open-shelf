'use strict';
/**
 * Vercel serverless entry. Vercel has no persistent disk, so this runs as a
 * self-seeding live demo: SQLite lives in /tmp and is re-seeded on cold start.
 * For real persistent data, point the app at a hosted database (see README).
 */
process.env.DB_PATH ||= '/tmp/openshelf.sqlite';
process.env.TRUST_PROXY ||= '1';

const { seedDemo } = require('../server/demo');
if (process.env.DEMO_MODE !== '0') seedDemo();

const { handler } = require('../server/index');
module.exports = handler;
