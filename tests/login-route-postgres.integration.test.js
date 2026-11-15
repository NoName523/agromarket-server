import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import request from 'supertest';

const loaded = dotenv.config({ path: '.env.test', override: true, quiet: true });
if (loaded.error || !loaded.parsed?.DATABASE_URL) throw new Error('Test environment unavailable');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.JWT_EXPIRES_IN = '2h';
process.env.LOGIN_ATTEMPT_SECRET = randomBytes(32).toString('hex');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '192.168.174.10' &&
  (!url.port || url.port === '5432') && decodeURIComponent(url.pathname.slice(1)) === 'agromarket_test' && !url.search,
'Unsafe configured PostgreSQL target');

const { pool } = await import('../db/pool.js');
const originalConnect = pool.connect.bind(pool);
const originalQuery = pool.query.bind(pool);
const originalCompare = bcrypt.compare;
const owned = new Set();
let targetFailed = false;
let failCommit = false;
let known = new Set();

async function verify(query) {
  if (targetFailed) throw new Error('Target guard previously failed');
  const { rows } = await query("SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port");
  const r = rows[0];
  if (r.db !== 'agromarket_test' || r.host !== '192.168.174.10' || r.port !== 5432 || process.env.NODE_ENV !== 'test') {
    targetFailed = true;
    throw new Error('Unsafe actual PostgreSQL target');
  }
}

pool.connect = async () => {
  if (targetFailed || process.env.NODE_ENV !== 'test') throw new Error('Target guard failed');
  const p = pool.options;
  const configured = new pg.Client({ connectionString: p.connectionString }).connectionParameters;
  assert.ok(configured.host === '192.168.174.10' && Number(configured.port) === 5432 && configured.database === 'agromarket_test');
  const client = await originalConnect();
  const raw = client.query.bind(client);
  try { await verify(raw); } catch (error) { client.release(true); throw error; }
  const release = client.release.bind(client);
  return {
    async query(sql, values = []) {
      if (sql === 'ROLLBACK') return raw(sql);
      await verify(raw);
      const command = sql.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (/^(INSERT|UPDATE|DELETE)\b/i.test(command)) {
        assert.match(command, /^(?:INSERT INTO|UPDATE|DELETE FROM) public\.login_attempt(?:s|_reservations)\b/i);
        assert.ok(owned.has(values[0]));
      } else assert.match(command, /^(SELECT\b|BEGIN$|COMMIT$|SET LOCAL\b)/i);
      if (failCommit && sql === 'COMMIT') { failCommit = false; throw new Error('simulated commit failure'); }
      return raw(sql, values);
    },
    release,
  };
};
pool.query = async (sql, values = []) => {
  if (sql.includes('FROM public.users WHERE email = $1')) {
    const email = values[0];
    return { rows: known.has(email) ? [{ id: 1, name: 'Test', email, role: 'user', password_hash: 'test-hash' }] : [] };
  }
  const client = await pool.connect();
  try { return await client.query(sql, values); } finally { client.release(); }
};
bcrypt.compare = async (password) => password === 'correct-password';
const { default: app } = await import('../app.js');

function fixture(t, account = true) {
  const email = `route-${randomUUID()}@example.invalid`;
  const key = createHmac('sha256', process.env.LOGIN_ATTEMPT_SECRET).update(email).digest('hex');
  owned.add(key);
  if (account) known.add(email);
  t.after(async () => {
    if (targetFailed) throw new Error('Cleanup stopped after target mismatch');
    await pool.query('DELETE FROM public.login_attempts WHERE email_key = $1', [key]);
    const { rows } = await pool.query(`SELECT
      (SELECT count(*)::int FROM public.login_attempts WHERE email_key = $1) AS states,
      (SELECT count(*)::int FROM public.login_attempt_reservations WHERE email_key = $1) AS reservations`, [key]);
    assert.deepEqual(rows[0], { states: 0, reservations: 0 });
    owned.delete(key);
    known.delete(email);
  });
  const login = (password = 'wrong-password', ip = '198.51.100.5') =>
    request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });
  const state = async () => (await pool.query('SELECT failed_count, blocked_until FROM public.login_attempts WHERE email_key = $1', [key])).rows[0];
  return { email, key, login, state };
}

describe('HTTP login with real PostgreSQL store', { concurrency: false }, () => {
  before(async () => { const client = await pool.connect(); client.release(); });
  beforeEach(async () => { const client = await pool.connect(); client.release(); });
  after(async () => { pool.connect = originalConnect; pool.query = originalQuery; bcrypt.compare = originalCompare; await pool.end(); });

  test('nine failures return 401; tenth returns 429 and does not extend the block', async (t) => {
    const f = fixture(t);
    for (let i = 0; i < 9; i++) assert.equal((await f.login()).status, 401);
    const tenth = await f.login();
    assert.equal(tenth.status, 429); assert.equal(tenth.headers['retry-after'], '60');
    const deadline = +(await f.state()).blocked_until;
    assert.equal((await f.login('correct-password')).status, 429);
    assert.equal(+(await f.state()).blocked_until, deadline);
  });

  test('success clears failures and returns JWT', async (t) => {
    const f = fixture(t);
    assert.equal((await f.login()).status, 401);
    const response = await f.login('correct-password');
    assert.equal(response.status, 200); assert.equal(response.body.token.split('.').length, 3);
    assert.equal((await f.state()).failed_count, 0);
  });

  test('unknown and known email have identical failure responses', async (t) => {
    const a = fixture(t); const b = fixture(t, false);
    const knownResponse = await a.login(); const unknownResponse = await b.login();
    assert.equal(knownResponse.status, 401); assert.equal(unknownResponse.status, 401);
    assert.deepEqual(knownResponse.body, unknownResponse.body);
  });

  test('concurrent requests share one limit', async (t) => {
    const f = fixture(t);
    const outcomes = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => f.login('wrong-password', `198.51.100.${i + 1}`)));
    assert.ok(outcomes.every((o) => o.status === 'fulfilled'));
    const responses = outcomes.map((o) => o.value);
    assert.equal(responses.filter((r) => r.status === 401).length, 9);
    assert.equal(responses.filter((r) => r.status === 429).length, 6);
    assert.equal((await f.state()).failed_count, 10);
  });

  test('database failure before recordSuccess returns 503 without JWT', async (t) => {
    const f = fixture(t);
    bcrypt.compare = async () => { failCommit = true; return true; };
    try {
      const response = await f.login('correct-password');
      assert.equal(response.status, 503); assert.equal(response.body.token, undefined);
      assert.equal((await f.state()).failed_count, 0);
    } finally { bcrypt.compare = async (password) => password === 'correct-password'; failCommit = false; }
  });
});
