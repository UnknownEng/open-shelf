'use strict';
/**
 * Demo data for sales demos: an admin, a few dozen members and 30 days of
 * realistic lending history so the dashboard has something to show.
 * Run with: npm run demo   (safe to run more than once)
 * Test accounts (local demo only — never use in production):
 *   admin@openshelf.test   / DemoAdmin!2026   (platform owner)
 *   reader@openshelf.test  / DemoReader!2026  (member)
 */
const { migrate, one, all, run, tx, id } = require('./db');
const { hashPassword } = require('./auth');
const { seedCatalogue } = require('./seed');


/** Seed demo members and history. Returns false if demo data already exists. */
function seedDemo({ adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'DemoAdmin!2026' } = {}) {
  migrate();
  seedCatalogue();
  if (one("SELECT id FROM users WHERE email='admin@openshelf.test'")) return false;
  const DAY = 86_400_000;
  const ago = (days, jitterHours = 0) => new Date(Date.now() - days * DAY - Math.random() * jitterHours * 3_600_000).toISOString();
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const FIRST = ['Ayesha', 'Hamza', 'Sara', 'Bilal', 'Noor', 'Mariam', 'Omar', 'Zara', 'Ali', 'Fatima', 'Usman', 'Hira', 'Daniyal', 'Amna', 'Saad', 'Iqra', 'Taha', 'Laiba', 'Faris', 'Mahnoor', 'Rayan', 'Eman', 'Shayan', 'Anaya'];
  const LAST = ['Khan', 'Ali', 'Ahmed', 'Raza', 'Fatima', 'Yusuf', 'Malik', 'Siddiqui', 'Qureshi', 'Sheikh', 'Butt', 'Chaudhry'];
  const CITIES = ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Peshawar', 'Multan', 'Faisalabad', 'Hyderabad', 'Quetta', 'Sialkot'];
  const REVIEWS = ['Could not put it down.', 'Kamaal ki kitaab!', 'Perfect for the metro bus ride.', 'Made me think for days.', 'Worth every credit.', 'Thora slow tha beech mein, but good.', 'Must read. Seriously.', ''];

  tx(() => {
    const mk = (name, email, pw, role, createdDaysAgo, credits = 3) => {
      const uid = id();
      run('INSERT INTO users(id,tenant_id,name,email,password_hash,city,role,credits,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        uid, 'default', name, email, hashPassword(pw), pick(CITIES), role, credits, ago(createdDaysAgo, 20));
      run("INSERT INTO memberships(id,user_id,plan,status,started_at) VALUES(?,?,'reader','active',?)", id(), uid, ago(createdDaysAgo));
      run("INSERT INTO credit_ledger(id,user_id,delta,reason,created_at) VALUES(?,?,3,'welcome',?)", id(), uid, ago(createdDaysAgo));
      return uid;
    };
    mk('Library Admin', 'admin@openshelf.test', adminPassword, 'owner', 40, 10);
    const reader = mk('Rida Hassan', 'reader@openshelf.test', 'DemoReader!2026', 'member', 35, 5);
    const members = [reader];
    for (let i = 0; i < 38; i++) {
      const first = FIRST[i % FIRST.length];
      const last = pick(LAST);
      members.push(mk(`${first} ${last}`, `${first}.${last}${i}@example.com`.toLowerCase(), `demo-${id()}`, 'member', 2 + Math.floor(Math.random() * 34), 5));
    }

    const books = all("SELECT id, total_copies, category FROM books WHERE tenant_id='default' AND archived=0 ORDER BY CAST(substr(id,2) AS INTEGER)");
    const LOCAL = ['Pakistani fiction', 'Urdu adab', 'Poetry'];
    const weights = books.map((b, i) => (LOCAL.includes(b.category) ? 5 : i < 6 ? 3 : 1) + b.total_copies);
    const weighted = () => {
      let r = Math.random() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < books.length; i++) { r -= weights[i]; if (r <= 0) return books[i]; }
      return books[0];
    };
    const activeByBook = new Map();
    const activeByUser = new Set();

    // Historical returned loans, increasing towards today (growth curve).
    for (let d = 29; d >= 0; d--) {
      const count = Math.round(1 + (29 - d) / 6 + Math.random() * 3);
      for (let k = 0; k < count; k++) {
        const b = weighted();
        const u = pick(members);
        const borrowed = ago(d, 10);
        const length = 4 + Math.random() * 18;
        const returnedMs = new Date(borrowed).getTime() + length * DAY;
        const due = new Date(new Date(borrowed).getTime() + 21 * DAY).toISOString();
        const loanId = id();
        if (returnedMs < Date.now() - DAY) {
          run("INSERT INTO loans(id,tenant_id,book_id,user_id,status,borrowed_at,due_at,returned_at) VALUES(?,'default',?,?,'returned',?,?,?)",
            loanId, b.id, u, borrowed, due, new Date(returnedMs).toISOString());
          if (Math.random() < 0.45) {
            run('INSERT OR IGNORE INTO reviews(id,book_id,user_id,rating,body,created_at) VALUES(?,?,?,?,?,?)',
              id(), b.id, u, pick([5, 5, 4, 4, 4, 3, 5]), pick(REVIEWS), new Date(returnedMs).toISOString());
          }
        } else {
          const onLoan = activeByBook.get(b.id) || 0;
          const key = `${u}:${b.id}`;
          if (onLoan >= b.total_copies || activeByUser.has(key) || Math.random() < 0.6) continue;
          activeByBook.set(b.id, onLoan + 1);
          activeByUser.add(key);
          run("INSERT INTO loans(id,tenant_id,book_id,user_id,status,borrowed_at,due_at) VALUES(?,'default',?,?,'active',?,?)", loanId, b.id, u, borrowed, due);
          run('UPDATE users SET credits=MAX(credits-1,0) WHERE id=?', u);
        }
      }
    }
    // A couple of overdue loans for the dashboard.
    for (const b of books.slice(10, 12)) {
      if ((activeByBook.get(b.id) || 0) >= b.total_copies) continue;
      activeByBook.set(b.id, (activeByBook.get(b.id) || 0) + 1);
      run("INSERT INTO loans(id,tenant_id,book_id,user_id,status,borrowed_at,due_at) VALUES(?,'default',?,?,'active',?,?)", id(), b.id, pick(members.slice(1)), ago(26), ago(5));
    }
  });
  return true;
}

module.exports = { seedDemo };

if (require.main === module) {
  console.log(seedDemo()
    ? 'Demo data created. Sign in as admin@openshelf.test / DemoAdmin!2026 (or reader@openshelf.test / DemoReader!2026).'
    : 'Demo data already present.');
}
