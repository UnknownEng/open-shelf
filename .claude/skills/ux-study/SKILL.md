---
name: ux-study
description: Simulate a usability study with ~500 everyday Pakistani users (25 persona groups) actually driving the Open Shelf site in a real browser on phones and slow networks, measuring task success and time. Use when asked how normal people, laymen or real users would experience the site.
---

# UX study (500 people as 25 persona groups)

- Personas span ages 16–65, students, office workers, homemakers, retirees, Urdu-first readers with weak English, first-time smartphone users, slow mobile data, low vision, one-thumb phone use. Each group ≈ 20 people.
- Drive the real site with Playwright + Chrome on a fresh local server (`PORT=3208`, demo data), mostly at 360×740 / 390×844, with network throttling (400 kbps / 400 ms) and reduced motion for some groups. Personas sign up themselves.
- Tasks: understand the site in 10 s; sign up; find a book (Roman-Urdu search e.g. "peer e kamil" and an English title); borrow; find due date; return; join a waitlist; sign out/in.
- Look at screenshots like a human. Report success rate and median time per task (weighted to 500), the top 10 problems ranked by people affected with evidence and fixes, and 3 things users loved. Save evidence under media/evaluation/ux/.
