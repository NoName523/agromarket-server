import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MockPostgres } from './helpers/mockLoginAttemptPostgres.js';
import { pool } from '../db/pool.js';

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.JWT_EXPIRES_IN = '2h';
const { default: app } = await import('../app.js');
const knownEmail = 'buyer@example.invalid';
let passwordHash;
let db;
let query;

const login = (email = knownEmail, password = 'wrong-password', ip = '198.51.100.50') =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });
const keyFor = (email) => createHmac('sha256', process.env.LOGIN_ATTEMPT_SECRET)
  .update(email.trim().toLowerCase()).digest('hex');
const stateFor = (email = knownEmail) => db.states.get(keyFor(email));

beforeAll(async () => { passwordHash = await bcrypt.hash('correct-password', 10); });
beforeEach(() => {
  db = new MockPostgres();
  vi.spyOn(pool, 'connect').mockImplementation(db.connect.bind(db));
  query = vi.spyOn(pool, 'query').mockImplementation(async (sql, values) => {
    if (!sql.includes('FROM public.users WHERE email = $1')) throw new Error('Unexpected SQL in route test');
    return { rows: values[0] === knownEmail ? [{ id: 1, name: 'Buyer', email: knownEmail,
      role: 'user', password_hash: passwordHash, created_at: null }] : [] };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('email protection in POST /api/auth/login', () => {
  it('normalizes email before reserving; wrong password records a failure without a token', async () => {
    const response = await login(' Buyer@Example.Invalid ');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Неверный email или пароль' });
    expect(query).toHaveBeenCalledWith(expect.any(String), [knownEmail]);
    expect(stateFor().failed_count).toBe(1);
    expect(response.body).not.toHaveProperty('token');
    expect(db.clients.every((c) => c.released)).toBe(true);
  });

  it('unknown email gets the same 401 and a dummy bcrypt check at the registration cost', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    const known = await login();
    const unknown = await login('missing@example.invalid');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(compare).toHaveBeenCalledTimes(2);
    expect(bcrypt.getRounds(compare.mock.calls[0][1])).toBe(10);
    expect(bcrypt.getRounds(compare.mock.calls[1][1])).toBe(10);
    expect(stateFor('missing@example.invalid').failed_count).toBe(1);
    expect(unknown.body).not.toHaveProperty('token');
  });

  it('the tenth failure from different IPs returns 429 and Retry-After; the block is not extended', async () => {
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false);
    for (let i = 0; i < 10; i++) {
      const response = await login(knownEmail, 'wrong-password', `198.51.100.${i + 1}`);
      expect(response.status).toBe(i < 9 ? 401 : 429);
      if (i === 9) {
        expect(response.headers['retry-after']).toBe('60');
        expect(response.body).toEqual({ error: 'Слишком много попыток входа. Повторите позже.' });
      }
    }
    const until = +stateFor().blocked_until;
    db.advance(20);
    const blocked = await login(knownEmail, 'correct-password', '198.51.100.200');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('40');
    expect(+stateFor().blocked_until).toBe(until);
    expect(blocked.body).not.toHaveProperty('token');
  });

  it('blocked known and unknown emails have identical responses without user lookup or bcrypt', async () => {
    const compare = vi.spyOn(bcrypt, 'compare').mockResolvedValue(false);
    for (const email of [knownEmail, 'missing@example.invalid']) {
      for (let i = 0; i < 10; i++) await login(email);
    }
    compare.mockClear();
    query.mockClear();
    const known = await login();
    const unknown = await login('missing@example.invalid');
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.headers['retry-after']).toBe(known.headers['retry-after']);
    expect(compare).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('only a committed successful reset returns JWT and clears failures', async () => {
    await login();
    const generation = stateFor().generation;
    const success = await login(knownEmail, 'correct-password');
    expect(success.status).toBe(200);
    expect(success.body.token.split('.')).toHaveLength(3);
    expect(success.body.user).not.toHaveProperty('password_hash');
    expect(stateFor().failed_count).toBe(0);
    expect(stateFor().generation).not.toBe(generation);
    expect(db.reservations.size).toBe(0);
  });

  it('concurrent HTTP requests share the email budget and cannot bypass the threshold', async () => {
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false);
    const responses = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      login(knownEmail, 'wrong-password', `198.51.100.${i + 1}`)));
    expect(responses.filter((r) => r.status === 401)).toHaveLength(9);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(6);
    expect(responses.every((r) => !r.body.token)).toBe(true);
    expect(stateFor().failed_count).toBe(10);
    expect(db.reservations.size).toBe(0);
  });

  it('late failed verification after success cannot restore the previous generation', async () => {
    let succeed;
    let fail;
    const successGate = new Promise((resolve) => { succeed = resolve; });
    const failureGate = new Promise((resolve) => { fail = resolve; });
    const compare = vi.spyOn(bcrypt, 'compare').mockImplementation((password) =>
      password === 'correct-password' ? successGate : failureGate);
    const successRequest = login(knownEmail, 'correct-password').then((r) => r);
    const failedRequest = login().then((r) => r);
    try {
      await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
      succeed(true);
      expect((await successRequest).status).toBe(200);
      fail(false);
      const late = await failedRequest;
      expect(late.status).toBe(429);
      expect(late.body).not.toHaveProperty('token');
      expect(stateFor().failed_count).toBe(0);
    } finally {
      succeed(true);
      fail(false);
      await Promise.allSettled([successRequest, failedRequest]);
    }
  });

  it('expired successful reservation does not issue JWT or silently retry', async () => {
    const compare = vi.spyOn(bcrypt, 'compare').mockImplementation(async () => {
      db.advance(31);
      return true;
    });
    const response = await login(knownEmail, 'correct-password');
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).not.toHaveProperty('token');
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it.each(['ensure', 'failure', 'reset'])('PostgreSQL error during %s returns safe 503 without JWT', async (tag) => {
    db.failTag = tag;
    const response = await login(knownEmail, tag === 'reset' ? 'correct-password' : 'wrong-password');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Вход временно недоступен. Повторите позже.' });
    expect(response.body).not.toHaveProperty('token');
    expect(JSON.stringify(response.body)).not.toMatch(/PostgreSQL|Simulated|password_hash|SELECT/);
  });

  it('user lookup failure returns safe 503 even after a successful reservation', async () => {
    query.mockRejectedValueOnce(new Error('private database details'));
    const response = await login();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Вход временно недоступен. Повторите позже.' });
    expect(db.reservations.size).toBe(1); // Expires by lease; never reset the account to bypass protection.
  });

  it('COMMIT failure after correct password never returns JWT and rolls back the reset', async () => {
    let failCommit = false;
    vi.mocked(pool.connect).mockImplementation(async () => {
      const client = await db.connect();
      const originalQuery = client.query;
      client.query = async (sql, values) => {
        if (failCommit && sql === 'COMMIT') {
          failCommit = false;
          throw new Error('private commit error');
        }
        return originalQuery(sql, values);
      };
      return client;
    });
    vi.spyOn(bcrypt, 'compare').mockImplementation(async () => {
      failCommit = true;
      return true;
    });
    const response = await login(knownEmail, 'correct-password');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Вход временно недоступен. Повторите позже.' });
    expect(response.body).not.toHaveProperty('token');
    expect(db.reservations.size).toBe(1);
    expect(db.clients.every((c) => c.released)).toBe(true);
  });

  it('IP limiter still allows ten failures across distinct emails, then blocks the eleventh', async () => {
    const previous = process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = 'true';
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false);
    const ip = '198.51.100.240';
    try {
      for (let i = 0; i < 10; i++) {
        expect((await login(`distinct-${i}@example.invalid`, 'wrong-password', ip)).status).toBe(401);
      }
      const blocked = await login('last@example.invalid', 'wrong-password', ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.ratelimit).toBeTruthy();
      expect(blocked.headers['ratelimit-policy']).toBeTruthy();
      expect(blocked.headers['retry-after']).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
      else process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = previous;
    }
  });

  it.each(['missing', 'short'])('startup fails with %s HMAC key even with valid JWT configuration', (mode) => {
    const code = `
      import pg from 'pg';
      import { randomBytes } from 'node:crypto';
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = randomBytes(32).toString('hex');
      process.env.JWT_EXPIRES_IN = '2h';
      delete process.env.LOGIN_ATTEMPT_SECRET;
      if (process.argv[1] === 'short') process.env.LOGIN_ATTEMPT_SECRET = 'short';
      pg.Pool.prototype.connect = () => { throw new Error('Unexpected database connection'); };
      try { await import('./routes/auth.js'); process.exitCode = 1; }
      catch (error) {
        if (!error.message.includes('LOGIN_ATTEMPT_SECRET')) process.exitCode = 2;
        else console.log('Startup rejected invalid LOGIN_ATTEMPT_SECRET');
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, mode],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Startup rejected invalid LOGIN_ATTEMPT_SECRET');
  });
});
