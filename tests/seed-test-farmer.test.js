import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { seedTestFarmer } from '../db/seed-test-farmer.js';

const url = 'postgresql://192.168.174.10:5432/agromarket_test';
const credentials = { email: 'farmer@test.invalid', password: 'fixture-password' };
const target = { database_name: 'agromarket_test', server_address: '192.168.174.10', server_port: 5432 };

function fakePool(actual = target, initial = null) {
  let account = initial;
  const calls = [];
  let connections = 0;
  return {
    calls,
    get connections() { return connections; },
    get account() { return account; },
    async connect() {
      connections++;
      return {
        async query(sql, values) {
          calls.push(sql);
          if (sql.includes('current_database()')) return { rows: [actual] };
          if (sql.includes('INSERT INTO public.users')) {
            if (account) return { rowCount: 0, rows: [] };
            account = { role: 'farmer', password_hash: values[1] };
            return { rowCount: 1, rows: [{ id: 1 }] };
          }
          if (sql.includes('SELECT role, password_hash')) return { rows: account ? [account] : [] };
          throw new Error('Unexpected query');
        },
        release() {},
      };
    },
  };
}

describe('test farmer seed safety', () => {
  for (const [name, databaseUrl, nodeEnv] of [
    ['NODE_ENV', url, 'production'],
    ['database', 'postgresql://192.168.174.10:5432/agromarket', 'test'],
    ['host', 'postgresql://example.invalid:5432/agromarket_test', 'test'],
    ['port', 'postgresql://192.168.174.10:5433/agromarket_test', 'test'],
    ['query override', `${url}?host=example.invalid`, 'test'],
  ]) {
    it(`rejects an unsafe configured ${name} before connecting`, async () => {
      const pool = fakePool();
      await assert.rejects(seedTestFarmer({ pool, databaseUrl, nodeEnv, ...credentials }));
      assert.equal(pool.connections, 0);
    });
  }

  for (const [name, actual] of [
    ['database', { ...target, database_name: 'agromarket' }],
    ['host', { ...target, server_address: '127.0.0.1' }],
    ['port', { ...target, server_port: 5433 }],
  ]) {
    it(`rejects a mismatched actual ${name} before writing`, async () => {
      const pool = fakePool(actual);
      await assert.rejects(seedTestFarmer({ pool, databaseUrl: url, nodeEnv: 'test', ...credentials }));
      assert.equal(pool.calls.length, 1);
      assert.match(pool.calls[0], /current_database/);
    });
  }

  it('creates a bcrypt-hashed farmer once and preserves it on repetition', async () => {
    const pool = fakePool();
    const args = { pool, databaseUrl: url, nodeEnv: 'test', ...credentials };
    assert.deepEqual(await seedTestFarmer(args), { created: true });
    const hash = pool.account.password_hash;
    assert.equal(await bcrypt.compare(credentials.password, hash), true);
    assert.deepEqual(await seedTestFarmer(args), { created: false });
    assert.equal(pool.account.password_hash, hash);
  });

  for (const role of ['user', 'admin']) {
    it(`does not change an existing ${role} account`, async () => {
      const account = { role, password_hash: 'existing-hash' };
      const pool = fakePool(target, account);
      await assert.rejects(seedTestFarmer({ pool, databaseUrl: url, nodeEnv: 'test', ...credentials }));
      assert.deepEqual(pool.account, account);
      assert.ok(pool.calls.every((sql) => !/\bUPDATE\b/i.test(sql)));
    });
  }

  it('does not overwrite an existing farmer with a different password', async () => {
    const account = { role: 'farmer', password_hash: await bcrypt.hash('different-password', 4) };
    const pool = fakePool(target, account);
    await assert.rejects(seedTestFarmer({ pool, databaseUrl: url, nodeEnv: 'test', ...credentials }));
    assert.deepEqual(pool.account, account);
  });
});
