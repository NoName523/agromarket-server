import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';

// Run explicitly with node --test. Never use Vitest globalSetup/db:init here.
const environment = dotenv.config({ path: '.env.test', override: true, quiet: true });
if (environment.error || !environment.parsed?.DATABASE_URL) {
  throw new Error('Integration tests require DATABASE_URL explicitly present in .env.test.');
}
process.env.NODE_ENV = 'test';
const connectionString = process.env.DATABASE_URL;
const url = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
  url.hostname === '192.168.174.10' && (!url.port || url.port === '5432') &&
  decodeURIComponent(url.pathname.slice(1)) === 'agromarket_test' && !url.search,
'Refusing integration tests: configured target is not the isolated VMware test database.');

const { createLoginAttemptStore } = await import('../services/loginAttemptStore.js');
// Ephemeral test-only key: never persisted, printed or assigned to application env.
const secret = randomBytes(32).toString('hex');
const ownedKeys = new Set();
const backendPids = new Set();
let unsafeTarget = false;
let injectConstraintFailure = false;

async function verifyTarget(query) {
  if (unsafeTarget) throw new Error('Target verification failed earlier; all further SQL is stopped.');
  const { rows } = await query(`SELECT current_database() AS database_name,
    host(inet_server_addr()) AS server_address, inet_server_port() AS server_port`);
  const actual = rows[0];
  if (actual?.database_name !== 'agromarket_test' || actual.server_address !== '192.168.174.10' ||
      actual.server_port !== 5432 || process.env.NODE_ENV !== 'test') {
    unsafeTarget = true;
    throw new Error('Target mismatch: no further test changes or cleanup are permitted.');
  }
}

function guardedPool() {
  const rawPool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=5000 -c lock_timeout=2000' });
  rawPool.on('error', () => { unsafeTarget = true; });
  // Inspect effective connection parameters without opening a socket.
  const probe = new pg.Client({ connectionString });
  assert.equal(probe.connectionParameters.host, '192.168.174.10');
  assert.equal(Number(probe.connectionParameters.port), 5432);
  assert.equal(probe.connectionParameters.database, 'agromarket_test');

  const pool = {
    async connect() {
      assert.equal(unsafeTarget, false, 'Stopped after a target verification failure');
      assert.equal(process.env.NODE_ENV, 'test');
      const raw = await rawPool.connect();
      const query = raw.query.bind(raw);
      try {
        await verifyTarget(query); // Before exposing this physical connection to the store.
      } catch (error) {
        raw.release(true);
        throw error;
      }
      backendPids.add(raw.processID);
      return {
        async query(sql, values = []) {
          // ROLLBACK must work even after an SQL error has aborted the transaction.
          // It never changes committed data and cannot run another operation.
          if (sql === 'ROLLBACK') return query(sql);
          await verifyTarget(query); // Same connection, immediately before each operation.
          const command = sql.replace(/\/\*[\s\S]*?\*\//g, '').trim();
          if (/^(INSERT|UPDATE|DELETE)\b/i.test(command)) {
            assert.match(command, /^(?:INSERT INTO|UPDATE|DELETE FROM) public\.login_attempt(?:s|_reservations)\b/i);
            assert.ok(ownedKeys.has(values[0]), 'Writes must be scoped to a key owned by this test run');
          } else {
            assert.ok(/^(SELECT\b|BEGIN$|COMMIT$|SET LOCAL\b)/i.test(command), 'Unexpected test SQL command');
          }
          if (injectConstraintFailure && sql.includes('login-attempt:failure')) {
            injectConstraintFailure = false;
            // Real PostgreSQL CHECK violation after reservation consumption, inside the store transaction.
            return query('UPDATE public.login_attempts SET failed_count = 11 WHERE email_key = $1', [values[0]]);
          }
          return query(sql, values);
        },
        release: (error) => raw.release(error),
      };
    },
    async query(sql, values) {
      const client = await pool.connect();
      try { return await client.query(sql, values); }
      finally { client.release(); }
    },
    end: () => rawPool.end(),
  };
  return pool;
}

const poolA = guardedPool();
const poolB = guardedPool();

async function fixture(t) {
  const email = `lab11-integration-${randomUUID()}@example.invalid`;
  const key = createHmac('sha256', secret).update(email).digest('hex');
  ownedKeys.add(key);
  t.after(async () => {
    if (unsafeTarget) throw new Error('Cleanup stopped because target verification failed.');
    // Foreign-key cascade removes only reservations belonging to this exact test key.
    await poolA.query('DELETE FROM public.login_attempts WHERE email_key = $1', [key]);
    const { rows } = await poolA.query(`SELECT
      (SELECT count(*)::int FROM public.login_attempts WHERE email_key = $1) AS states,
      (SELECT count(*)::int FROM public.login_attempt_reservations WHERE email_key = $1) AS reservations`, [key]);
    assert.deepEqual(rows[0], { states: 0, reservations: 0 });
    ownedKeys.delete(key);
  });
  return { email, key,
    store: createLoginAttemptStore({ pool: poolA, secret }),
    other: createLoginAttemptStore({ pool: poolB, secret }),
    state: async () => (await poolA.query(`SELECT generation, failed_count, blocked_until,
      extract(epoch FROM (blocked_until - clock_timestamp()))::float8 AS block_seconds
      FROM public.login_attempts WHERE email_key = $1`, [key])).rows[0],
    pending: async () => (await poolA.query(
      'SELECT count(*)::int AS count FROM public.login_attempt_reservations WHERE email_key = $1', [key])).rows[0].count,
  };
}

async function fail(store, email) {
  const reservation = await store.reserveAttempt(email);
  assert.equal(reservation.allowed, true);
  return store.recordFailure(reservation);
}

// Wait for every worker before cleanup even when one concurrent operation fails.
async function together(operations) {
  const results = await Promise.allSettled(operations);
  const error = results.find((r) => r.status === 'rejected');
  if (error) throw error.reason;
  return results.map((r) => r.value);
}

describe('loginAttemptStore / isolated VMware PostgreSQL integration', { concurrency: false }, () => {
  before(async () => {
    try {
      for (const pool of [poolA, poolB]) {
        const result = await pool.query(`SELECT to_regclass('public.login_attempts') IS NOT NULL AS states,
          to_regclass('public.login_attempt_reservations') IS NOT NULL AS reservations`);
        assert.deepEqual(result.rows[0], { states: true, reservations: true },
          'Required tables are absent; this test never runs migrations.');
      }
      console.log('Verified target: agromarket_test / 192.168.174.10:5432 / NODE_ENV=test');
    } catch (error) {
      // Driver messages may include connection details: expose only a safe code.
      const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'TARGET_OR_SCHEMA_CHECK_FAILED';
      throw new Error(`Integration preflight failed: ${code}`);
    }
  });
  after(async () => {
    await Promise.all([poolA.end(), poolB.end()]);
  });

  test('ten failures block further attempts for 60 seconds without extending the deadline', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await fail(f.store, f.email), { applied: true, blocked: i === 9 });
    }
    const before = await f.state();
    assert.equal(before.failed_count, 10);
    assert.ok(before.block_seconds > 55 && before.block_seconds <= 60);
    for (let i = 0; i < 3; i++) {
      const blocked = await f.other.reserveAttempt(f.email);
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.reason, 'blocked');
      assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
    }
    assert.equal(+(await f.state()).blocked_until, +before.blocked_until);
  });

  test('concurrent requests over two independent pools cannot reserve more than ten slots', async (t) => {
    const f = await fixture(t);
    const results = await together(Array.from({ length: 24 }, (_, i) =>
      (i % 2 ? f.other : f.store).reserveAttempt(f.email)));
    assert.equal(results.filter((r) => r.allowed).length, 10);
    assert.equal(results.filter((r) => r.reason === 'in-flight').length, 14);
    assert.equal(await f.pending(), 10);
    assert.equal((await f.state()).failed_count, 0);
    assert.ok(backendPids.size >= 2, 'Must exercise multiple physical PostgreSQL connections');
    await together(results.filter((r) => r.allowed).map((r, i) =>
      (i % 2 ? f.other : f.store).recordFailure(r)));
    assert.equal((await f.state()).failed_count, 10);
    assert.equal(await f.pending(), 0);
    assert.equal((await f.store.reserveAttempt(f.email)).reason, 'blocked');
  });

  test('two store instances share failures and normalize the same email', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 10; i++) {
      await fail(i % 2 ? f.other : f.store, i % 2 ? ` ${f.email.toUpperCase()} ` : f.email);
    }
    assert.equal((await f.other.reserveAttempt(f.email)).reason, 'blocked');
    assert.equal((await f.state()).failed_count, 10);
  });

  test('success resets failures, changes generation and invalidates a late old failure', async (t) => {
    const f = await fixture(t);
    await fail(f.store, f.email);
    const success = await f.store.reserveAttempt(f.email);
    const late = await f.other.reserveAttempt(f.email);
    assert.deepEqual(await f.store.recordSuccess(success), { applied: true });
    const state = await f.state();
    assert.equal(state.failed_count, 0);
    assert.equal(state.blocked_until, null);
    assert.notEqual(state.generation, late.generation);
    assert.equal(await f.pending(), 0);
    const fresh = await f.store.reserveAttempt(f.email);
    assert.deepEqual(await f.other.recordFailure(late), { applied: false });
    assert.equal((await f.state()).failed_count, 0);
    assert.deepEqual(await f.store.recordSuccess(fresh), { applied: true });
  });

  test('racing success and failure cannot leave the old failure count after success', async (t) => {
    const f = await fixture(t);
    const success = await f.store.reserveAttempt(f.email);
    const failure = await f.other.reserveAttempt(f.email);
    const [a, b] = await together([f.store.recordSuccess(success), f.other.recordFailure(failure)]);
    assert.equal(a.applied, true);
    assert.equal(typeof b.applied, 'boolean'); // Either serialization order is valid.
    assert.equal((await f.state()).failed_count, 0);
    assert.equal(await f.pending(), 0);
  });

  test('expired leases release capacity and cannot later record failure or success', async (t) => {
    const f = await fixture(t);
    const old = await together(Array.from({ length: 10 }, () => f.store.reserveAttempt(f.email)));
    await poolA.query(`UPDATE public.login_attempt_reservations
      SET reserved_at = clock_timestamp() - interval '2 minutes',
          lease_expires_at = clock_timestamp() - interval '1 minute' WHERE email_key = $1`, [f.key]);
    assert.deepEqual(await f.store.recordFailure(old[0]), { applied: false });
    assert.deepEqual(await f.other.recordSuccess(old[1]), { applied: false });
    assert.equal((await f.other.reserveAttempt(f.email)).allowed, true);
    assert.equal(await f.pending(), 1);
    assert.equal((await f.state()).failed_count, 0);
  });

  test('expired block resets automatically using the database clock', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 10; i++) await fail(f.store, f.email);
    const old = (await f.state()).generation;
    await poolA.query(`UPDATE public.login_attempts
      SET window_started_at = clock_timestamp() - interval '2 minutes',
          blocked_until = clock_timestamp() - interval '1 second' WHERE email_key = $1`, [f.key]);
    const fresh = await f.other.reserveAttempt(f.email);
    assert.equal(fresh.allowed, true);
    assert.notEqual(fresh.generation, old);
    assert.equal((await f.state()).failed_count, 0);
    assert.equal((await f.state()).blocked_until, null);
  });

  test('concurrent replay consumes one reservation exactly once', async (t) => {
    const f = await fixture(t);
    const r = await f.store.reserveAttempt(f.email);
    const results = await together([f.store.recordFailure(r), f.other.recordFailure(r)]);
    assert.equal(results.filter((r) => r.applied).length, 1);
    assert.equal((await f.state()).failed_count, 1);
    assert.equal(await f.pending(), 0);
    assert.deepEqual(await f.store.recordSuccess(r), { applied: false });
  });

  test('real CHECK violation rolls back reservation consumption and leaves connection reusable', async (t) => {
    const f = await fixture(t);
    const r = await f.store.reserveAttempt(f.email);
    injectConstraintFailure = true;
    try {
      await assert.rejects(f.store.recordFailure(r), (error) => error.code === '23514');
    } finally {
      injectConstraintFailure = false;
    }
    assert.equal((await f.state()).failed_count, 0);
    assert.equal((await f.state()).blocked_until, null);
    assert.equal(await f.pending(), 1);
    assert.deepEqual(await f.other.recordFailure(r), { applied: true, blocked: false });
    assert.equal((await f.state()).failed_count, 1);
    assert.equal(await f.pending(), 0);
  });
});
