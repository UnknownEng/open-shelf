# Open Shelf

A **white-label, credit-based book lending platform**. Readers borrow physical books with credits, return them for the next reader, and join waitlists when every copy is out. Libraries, campuses and partner platforms run their own branded tenant, with an admin console, a partner REST API, SSO hand-off and signed webhooks.

**Live demo:** https://open-shelf-rho.vercel.app (self-seeding sandbox, data resets when the server restarts)

Zero runtime dependencies: Node.js 22.13+ (built-in `node:sqlite`), vanilla JS front end.

## Quick start

```bash
npm run demo     # seeds openshelf-demo.sqlite with 40 members + 30 days of history, then serves http://localhost:3000
npm start        # real database (openshelf.sqlite), no demo data
npm test         # end-to-end API tests on a throwaway database
npm run test:e2e # 30 real-browser tests (needs Chrome + `npm i --no-save playwright-core`)
```

Staff console: **/admin** (own sign-in page). Project skills for re-running the evaluations live in `.claude/skills/` (`/load-test`, `/red-team`, `/qa-sweep`, `/ux-study`, `/judge-panel`).

Demo accounts (local demo database only):

| Role | Email | Password |
|---|---|---|
| Platform owner | `admin@openshelf.test` | `DemoAdmin!2026` |
| Member | `reader@openshelf.test` | `DemoReader!2026` |

Promote a real account: `npm run make-admin -- someone@example.com` (append `owner` for platform owner).

## What's in the box

**Members:** catalogue search and filters, 3D book detail, borrowing with credits, returns, one renewal, FIFO waitlists with 48-hour holds, reviews (only after borrowing), notifications, credit ledger, profile and password change.

**Staff console** (`#/admin`): KPIs and 30-day charts, catalogue CRUD with copy counts and archiving, member management (credits, roles, suspension), circulation check-in, waitlists, branding and lending rules, API keys, webhooks with delivery logs, audit log, and tenant provisioning (owners).

**Partner API** (`/api/v1`, `Authorization: Bearer osk_…`):
- `POST /api/v1/members`: provision members from your platform (SSO-only)
- `POST /api/v1/members/:id/credits`: grant credits after a payment
- `POST /api/v1/members/:id/login-link`: one-time SSO link into the member's shelf
- `POST /api/v1/books`: bulk catalogue import (500 per call)
- `GET /api/v1/loans`, `GET /api/v1/stats`, `POST /api/v1/loans/:id/checkin`

Full spec: `GET /api/openapi.json` (generated from the route table).

**Webhooks:** `loan.created`, `loan.returned`, `loan.renewed`, `loan.overdue`, `reservation.created`, `reservation.ready`, `reservation.expired`, `ping`. Each body is signed: `X-OpenShelf-Signature: sha256=HMAC(secret, body)`.

## Architecture

```
server/
  index.js            HTTP server, auth pipeline, static files (CSP, gzip), jobs, CLI
  db.js               SQLite connection, versioned migrations, transaction helper
  auth.js             scrypt passwords, hashed session tokens, API keys
  services/library.js lending domain: availability, borrow/return/renew, waitlist, jobs
  services/members.js member creation and credit adjustments
  routes/public.js    member + catalogue API
  routes/admin.js     staff console API
  routes/partner.js   partner API v1
  events.js           notifications, audit log, signed webhooks
public/               SPA: index.html, css/app.css, js/ (views, effects, API client)
android/              WebView wrapper app
test/api.test.js      end-to-end tests
```

Security: scrypt password hashing, HttpOnly SameSite session cookies (stored as SHA-256 hashes), Origin and JSON content-type checks against CSRF, per-IP/per-account rate limits, strict CSP, parameterised SQL everywhere, tenant isolation on every query, and an audit trail.

## Production checklist

- On the Vercel demo, set `DEMO_ADMIN_PASSWORD` (Project → Settings → Environment Variables); without it the demo admin account is locked with a random password.
- Run behind HTTPS with `NODE_ENV=production` (adds `Secure` cookies) and `PUBLIC_URL=https://your-domain`.
- Set `TRUST_PROXY=1` when behind a load balancer so rate limits see real client IPs.
- Back up the SQLite file (or move to Postgres before multi-instance scale-out). Replace the in-memory rate limiter with Redis when running several instances.
- Add transactional email (verification, password reset, due-date reminders) and a payment provider for paid memberships.
- Build the Android app against your URL: `cd android && .\gradlew.bat assembleRelease -PopenshelfUrl=https://your-domain`, then configure release signing.

The previous prototype is kept in `_prototype_backup/`.
