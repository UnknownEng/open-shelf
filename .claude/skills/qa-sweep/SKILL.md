---
name: qa-sweep
description: Verify every Open Shelf feature works by running real browser end-to-end tests (Playwright driving Chrome) against a fresh local server, and report pass/fail from actual runs. Use when asked to test everything, QA the app, or check that all features work.
---

# QA sweep

1. `npm test` (API end-to-end tests) must pass first.
2. Fresh server: `export DB_PATH="$TEMP/os-qa.sqlite"; rm -f "$DB_PATH"*; node server/demo.js; PORT=3207 LOG=0 RATE_LIMIT_SCALE=50 node server/index.js &`
3. Browser suite: `test/e2e.test.js` (needs `npm i -D playwright-core` and Google Chrome; run `E2E_BASE=http://localhost:3207 node --test test/e2e.test.js`). If the file is missing, write it covering: home, browse filters/search/sort, book modal (borrow, waitlist, return, renew, review), sign-up/sign-in/out, shelf, notifications, theme persistence, 375px mobile tab bar, /admin sign-in + every console tab (catalogue CRUD, members incl. detail/credits/roles/suspend, circulation check-in, API keys, webhooks, settings brand colour, audit, tenants), CSV exports, partner SSO link.
4. Report a pass/fail table from the final run; for each failure give steps, expected vs actual, a screenshot and the suspected file:line. Distinguish flaky tests from app bugs.
