'use strict';
const { one, run, tx, now, id } = require('../db');
const { HttpError } = require('../http');
const { hashPassword, USER_SQL } = require('../auth');
const { notify } = require('../events');

/** Create a member inside a tenant with welcome credits, membership and ledger entry. */
async function createMember(tenant, { name, email, city = '', password = null, externalId = null, credits }) {
  if (one('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with that email already exists.');
  const passwordHash = password ? await hashPassword(password) : 'sso-only'; // hashed before the (synchronous) transaction
  if (one('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with that email already exists.');
  const userId = id();
  const startCredits = credits ?? tenant.welcome_credits;
  try {
    tx(() => {
      run('INSERT INTO users(id,tenant_id,name,email,password_hash,city,credits,external_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        userId, tenant.id, name, email, passwordHash, city || '—', startCredits, externalId, now());
      run("INSERT INTO memberships(id,user_id,plan,status,started_at) VALUES(?,?,'reader','active',?)", id(), userId, now());
      if (startCredits) run('INSERT INTO credit_ledger(id,user_id,delta,reason,created_at) VALUES(?,?,?,?,?)', id(), userId, startCredits, 'welcome', now());
      notify(userId, 'welcome', `Welcome to ${tenant.name}`, `${startCredits} borrowing credits are ready. Pick your first book!`);
    });
  } catch (err) {
    // Two simultaneous sign-ups with the same email: the UNIQUE constraint decides the winner.
    if (/UNIQUE constraint failed: users\.email/.test(err.message)) throw new HttpError(409, 'An account with that email already exists.');
    throw err;
  }
  return getMember(userId);
}

const getMember = (userId) => one(`${USER_SQL} WHERE u.id=?`, userId);

/** Add or remove credits with a ledger entry. Balance can never go negative. */
function adjustCredits(userId, delta, reason) {
  return tx(() => {
    const u = one('SELECT credits FROM users WHERE id=?', userId);
    if (!u) throw new HttpError(404, 'Member not found.');
    if (u.credits + delta < 0) throw new HttpError(409, `Member only has ${u.credits} credits.`);
    run('UPDATE users SET credits=credits+? WHERE id=?', delta, userId);
    run('INSERT INTO credit_ledger(id,user_id,delta,reason,created_at) VALUES(?,?,?,?,?)', id(), userId, delta, reason, now());
    if (delta > 0) notify(userId, 'credits', `${delta} credit${delta === 1 ? '' : 's'} added`, 'Your balance has been topped up. Happy reading!');
    return { credits: u.credits + delta };
  });
}

module.exports = { createMember, getMember, adjustCredits };
