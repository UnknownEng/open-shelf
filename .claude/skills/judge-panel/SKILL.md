---
name: judge-panel
description: Evaluate the Open Shelf business with a simulated panel of 100 independent judges (investors, platform partners, librarians, bookstores, logistics, finance, product, impact, devil's advocates), scoring 7 criteria each and aggregating with a script. Use when asked to evaluate, judge or score the business idea or pitch.
---

# 100-judge panel

1. Read README.md and the latest facts (traction, pilots, pricing, logistics and loss policy — update the brief if these changed since the last run).
2. Define 100 distinct fictional judges across the groups above (state the mix); each scores 1–10 on problem, market, model, moat, execution risk (10 = low), partner appeal, pitch readiness, plus a one-sentence verdict and take-meeting yes/no. Keep them genuinely independent.
3. Write all rows to media/evaluation/judges.csv and compute aggregates with a script (means, per-group means, % yes, distribution) — never eyeball.
4. Report: aggregate table, % yes, partner segment ranking, objections ranked by count, top strengths, 3 highest-impact fixes, verdict. Compare with the previous run if a local media/evaluation/judges.csv exists (reports stay local and are git-ignored).
