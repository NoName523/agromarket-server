import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createLoginAttemptStore, LOGIN_ATTEMPT_POLICY } from '../services/loginAttemptStore.js';
import { MockPostgres } from './helpers/mockLoginAttemptPostgres.js';

const TEST_SECRET = 'unit-test-only-login-attempt-key-0000';
const EMAIL = 'buyer@example.invalid';

function fixture() {
  const db = new MockPostgres();
  const store = createLoginAttemptStore({ pool: db, secret: TEST_SECRET });
  return { db, store };
}

async function fail(store, email = EMAIL) {
  const reservation = await store.reserveAttempt(email);
  assert.equal(reservation.allowed, true);
  return store.recordFailure(reservation);
}

test('requires a separate key and rejects empty/short keys without querying PostgreSQL', () => {
  for (const secret of ['', 'short', null]) {
    assert.throws(() => createLoginAttemptStore({ pool: {}, secret }), /LOGIN_ATTEMPT_SECRET/);
  }
});

test('HMAC normalizes email and never passes the original email to PostgreSQL', async () => {
  const { db, store } = fixture();
  const first = await store.reserveAttempt(' Buyer@Example.Invalid ');
  const second = await store.reserveAttempt(EMAIL);
  assert.equal(first.emailKey, createHmac('sha256', TEST_SECRET).update(EMAIL).digest('hex'));
  assert.equal(first.emailKey, second.emailKey);
  assert.notEqual(first.attemptId, second.attemptId);
  assert.equal(JSON.stringify(db.calls).toLowerCase().includes(EMAIL), false);
});

test('ten failures are recorded; next request is blocked for 60 seconds without extending it', async () => {
  const { db, store } = fixture();
  for (let i = 0; i < 10; i++) assert.deepEqual(await fail(store), { applied: true, blocked: i === 9 });
  const deadline = +[...db.states.values()][0].blocked_until;
  assert.deepEqual(await store.reserveAttempt(EMAIL), { allowed: false, reason: 'blocked', retryAfterSeconds: 60 });
  db.advance(20);
  assert.equal((await store.reserveAttempt(EMAIL)).retryAfterSeconds, 40);
  assert.equal(+[...db.states.values()][0].blocked_until, deadline);
});

test('two store instances share capacity: concurrent reservations cannot exceed ten', async () => {
  const { db, store } = fixture();
  const other = createLoginAttemptStore({ pool: db, secret: TEST_SECRET });
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    (i % 2 ? other : store).reserveAttempt(EMAIL)));
  assert.equal(results.filter((r) => r.allowed).length, 10);
  assert.equal(results.filter((r) => r.reason === 'in-flight').length, 15);
  assert.equal([...db.states.values()][0].failed_count, 0);
  assert.equal(db.reservations.size, 10);
  assert.ok(db.clients.every((c) => c.released));
});

test('concurrent failure completions count once each and create one block', async () => {
  const { db, store } = fixture();
  const reservations = await Promise.all(Array.from({ length: 10 }, () => store.reserveAttempt(EMAIL)));
  await Promise.all(reservations.map((r) => store.recordFailure(r)));
  assert.equal([...db.states.values()][0].failed_count, 10);
  assert.equal(db.reservations.size, 0);
  assert.equal((await store.reserveAttempt(EMAIL)).reason, 'blocked');
});

test('existing failures and in-flight reservations share the same ten-attempt budget', async () => {
  const { db, store } = fixture();
  for (let i = 0; i < 7; i++) await fail(store);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.reserveAttempt(EMAIL)));
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal([...db.states.values()][0].failed_count, 7);
  assert.equal(db.reservations.size, 3);
});

test('concurrent success and late failure leave no restored failure count', async () => {
  const { db, store } = fixture();
  const success = await store.reserveAttempt(EMAIL);
  const failure = await store.reserveAttempt(EMAIL);
  const [a, b] = await Promise.all([store.recordSuccess(success), store.recordFailure(failure)]);
  assert.deepEqual(a, { applied: true });
  assert.deepEqual(b, { applied: false });
  assert.equal([...db.states.values()][0].failed_count, 0);
  assert.equal(db.reservations.size, 0);
});

test('success resets failures and invalidates late failures from the old generation', async () => {
  const { db, store } = fixture();
  await fail(store);
  const success = await store.reserveAttempt(EMAIL);
  const late = await store.reserveAttempt(EMAIL);
  assert.deepEqual(await store.recordSuccess(success), { applied: true });
  const fresh = await store.reserveAttempt(EMAIL);
  assert.notEqual(fresh.generation, late.generation);
  assert.deepEqual(await store.recordFailure(late), { applied: false });
  assert.equal([...db.states.values()][0].failed_count, 0);
  assert.deepEqual(await store.recordSuccess(success), { applied: false });
  assert.deepEqual(await store.recordSuccess(fresh), { applied: true });
});

test('failure that completes before success is cleared by success', async () => {
  const { db, store } = fixture();
  const a = await store.reserveAttempt(EMAIL);
  const b = await store.reserveAttempt(EMAIL);
  await store.recordFailure(a);
  await store.recordSuccess(b);
  assert.equal([...db.states.values()][0].failed_count, 0);
});

test('a reservation can be consumed only once, even with concurrent replay', async () => {
  const { db, store } = fixture();
  const r = await store.reserveAttempt(EMAIL);
  const outcomes = await Promise.all([store.recordFailure(r), store.recordFailure(r)]);
  assert.equal(outcomes.filter((o) => o.applied).length, 1);
  assert.equal([...db.states.values()][0].failed_count, 1);
});

test('abandoned leases free capacity and late completion cannot modify state', async () => {
  const { db, store } = fixture();
  const old = await Promise.all(Array.from({ length: 10 }, () => store.reserveAttempt(EMAIL)));
  db.advance(30);
  assert.deepEqual(await store.recordFailure(old[0]), { applied: false });
  assert.deepEqual(await store.recordSuccess(old[1]), { applied: false });
  assert.equal((await store.reserveAttempt(EMAIL)).allowed, true);
  assert.equal(db.reservations.size, 1);
  assert.equal([...db.states.values()][0].failed_count, 0);
});

test('block expires automatically and starts a fresh generation', async () => {
  const { db, store } = fixture();
  for (let i = 0; i < 10; i++) await fail(store);
  const old = [...db.states.values()][0].generation;
  db.advance(60);
  const fresh = await store.reserveAttempt(EMAIL);
  assert.equal(fresh.allowed, true);
  assert.notEqual(fresh.generation, old);
  assert.equal([...db.states.values()][0].failed_count, 0);
});

test('a 60-second block is not shortened by the end of the 15-minute window', async () => {
  const { db, store } = fixture();
  await fail(store);
  db.advance(899);
  for (let i = 0; i < 9; i++) await fail(store);
  db.advance(2);
  assert.equal((await store.reserveAttempt(EMAIL)).retryAfterSeconds, 58);
});

test('observation window expires on the PostgreSQL clock', async () => {
  const { db, store } = fixture();
  await fail(store);
  db.advance(LOGIN_ATTEMPT_POLICY.windowSeconds);
  assert.equal((await store.reserveAttempt(EMAIL)).allowed, true);
  assert.equal([...db.states.values()][0].failed_count, 0);
});

test('different and unknown emails are independent and do not require a users lookup', async () => {
  const { db, store } = fixture();
  for (let i = 0; i < 10; i++) await fail(store, 'missing@example.invalid');
  assert.equal((await store.reserveAttempt('missing@example.invalid')).allowed, false);
  assert.equal((await store.reserveAttempt(EMAIL)).allowed, true);
  assert.ok(db.calls.every(({ sql }) => !sql.includes('public.users')));
});

test('cleanup is bounded and expired state cannot be resurrected by late results', async () => {
  const { db, store } = fixture();
  const old = await store.reserveAttempt(EMAIL);
  await store.reserveAttempt('other@example.invalid');
  db.advance(960);
  assert.deepEqual(await store.cleanupExpired({ limit: 1 }), { deleted: 1 });
  assert.deepEqual(await store.recordFailure(old), { applied: false });
  const fresh = await store.reserveAttempt(EMAIL);
  assert.notEqual(fresh.generation, old.generation);
  assert.deepEqual(await store.recordSuccess(old), { applied: false });
});

test('database failure rolls back and releases the client without reporting success', async () => {
  const { db, store } = fixture();
  const r = await store.reserveAttempt(EMAIL);
  db.failTag = 'failure';
  await assert.rejects(store.recordFailure(r), /Simulated database failure/);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(db.clients.every((c) => c.released));
  assert.equal([...db.states.values()][0].failed_count, 0);
  db.failTag = null;
  assert.deepEqual(await store.recordFailure(r), { applied: true, blocked: false });
});

test('rejects invalid email, reservation and cleanup limits before connecting', async () => {
  const { db, store } = fixture();
  await assert.rejects(store.reserveAttempt(' '), /email/);
  await assert.rejects(store.recordSuccess({}), /reservation/);
  await assert.rejects(store.cleanupExpired({ limit: 0 }), /limit/);
  assert.equal(db.calls.length, 0);
});

test('fresh schema and migration contain matching DDL for both tables and indexes', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../db/migrate.js', import.meta.url), 'utf8');
  const normalize = (s) => s.replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ').trim();
  for (const name of ['login_attempts', 'login_attempt_reservations']) {
    const pattern = new RegExp('CREATE TABLE (?:IF NOT EXISTS )?public\\.' + name + ' \\([\\s\\S]*?\\n  ?\\)');
    // Compare full statements rather than merely checking that table names occur.
    const fresh = schema.match(new RegExp('CREATE TABLE public\\.' + name + ' \\([\\s\\S]*?\\n\\);'))?.[0];
    const update = migration.match(pattern)?.[0];
    assert.ok(fresh && update);
    assert.equal(normalize(fresh.replace(/;$/, '')), normalize(update));
  }
  for (const name of ['login_attempts_expiry_idx', 'login_attempt_reservations_lease_idx']) {
    assert.ok(schema.includes(name) && migration.includes(name));
  }
});
