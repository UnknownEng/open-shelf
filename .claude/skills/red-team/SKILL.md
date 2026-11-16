---
name: red-team
description: Run an authorized security assessment of Open Shelf — authenticated attacks against a local copy plus gentle unauthenticated checks of the live deployment — and report only proven vulnerabilities. Use when asked to hack, pen-test, security review or attack the site.
---

# Red team

Scope: the owner's own app. Authenticated/destructive testing only against a LOCAL copy; the live site gets unauthenticated, low-rate checks (≤3 req/s, no account creation, no passwords, no floods).

Local target (keep real rate limits):
```bash
export DB_PATH="$TEMP/os-redteam.sqlite"; rm -f "$DB_PATH"*; node server/demo.js
PORT=3206 LOG=0 node server/index.js &
```
Demo accounts (local only): admin@openshelf.test / DemoAdmin!2026 (owner), reader@openshelf.test / DemoReader!2026.

Checklist: auth bypass, session handling, brute force vs per-IP and per-email limits (incl. X-Forwarded-For spoofing), privilege escalation (member→admin→owner, mass assignment on PATCH /api/me), IDOR across users and tenants (create a 2nd tenant; X-Tenant header), credit fraud & race conditions (parallel borrow/return/renew/reserve), SQL injection, stored XSS (CSP is script-src 'self'), CSRF (foreign Origin, text/plain), SSRF via webhook URLs, SSO link reuse/expiry, revoked API keys, CSV formula injection (/api/admin/export/:kind), static path traversal, oversized bodies, error/header disclosure, cookie flags, CDN caching of private responses on the live site.

Output: confirmed findings only — severity, file:line, exact exploit + observed response, fix — plus a table of defences that held. Save evidence under media/evaluation/redteam/. Re-run `npm test` after fixes.
