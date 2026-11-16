---
name: load-test
description: Load-test Open Shelf with 500 simulated users (full journey locally, read-only burst on a live URL) and verify credit/copy invariants afterwards. Use when asked to stress test, load test or check performance under traffic.
---

# Load test (500 virtual users)

1. Start an isolated local server with demo data and raised rate limits (all traffic comes from one IP):
   ```bash
   export DB_PATH="$TEMP/os-load.sqlite"; rm -f "$DB_PATH"*; node server/demo.js
   PORT=3209 LOG=0 RATE_LIMIT_SCALE=1000 node server/index.js &
   ```
2. Full journey (browse → sign up → borrow → shelf → return): `node tools/load/loadtest.js http://localhost:3209 full 500`
3. Invariants must all be 0 mismatches: `node tools/load/invariants.js "$DB_PATH"` (negative credits, books lent beyond copies, credits ≠ ledger).
4. Live site: read-only only, one burst: `node tools/load/loadtest.js https://open-shelf-rho.vercel.app read 500`. Never run `full` mode against production (it creates accounts).
5. Report p50/p95/p99 per endpoint, error count, status-code mix and invariants. Network errors > 0 or p95 > 1s locally (excluding register) is a regression. Kill the local server afterwards.
