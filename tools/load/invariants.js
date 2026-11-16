// Checks lending invariants on a database after a load test. Usage: node invariants.js <dbPath>
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[2]);
const q = (sql) => d.prepare(sql).get().n;
console.log('users with negative credits :', q('SELECT COUNT(*) n FROM users WHERE credits < 0'));
console.log('books lent beyond copies    :', q("SELECT COUNT(*) n FROM books b WHERE (SELECT COUNT(*) FROM loans l WHERE l.book_id=b.id AND l.status='active') > b.total_copies"));
console.log('credits != ledger (load users):', q("SELECT COUNT(*) n FROM users u WHERE u.email LIKE 'load%' AND u.credits != (SELECT COALESCE(SUM(delta),0) FROM credit_ledger c WHERE c.user_id=u.id)"));
console.log('load users created          :', q("SELECT COUNT(*) n FROM users WHERE email LIKE 'load%'"));
console.log('loans by load users         :', q("SELECT COUNT(*) n FROM loans l JOIN users u ON u.id=l.user_id WHERE u.email LIKE 'load%'"));
