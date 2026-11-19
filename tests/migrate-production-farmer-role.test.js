import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { productionFarmerConfig, migrateProductionFarmerRole, assertProductionChannelBinding, trackProductionChannelBinding } from '../db/migrate-production-farmer-role.js';

const options = {
  databaseUrl: 'postgresql://fixture:fixture@ep-example.region.aws.neon.tech:5432/neondb?sslmode=require',
  nodeEnv: 'production', confirmation: 'I_CONFIRM_PRODUCTION_FARMER_ROLE_MIGRATION',
  expectedHost: 'ep-example.region.aws.neon.tech', expectedDatabase: 'neondb',
};

test('production guard requires explicit production target, confirmation and safe connection options', () => {
  assert.equal(productionFarmerConfig(options).ssl.rejectUnauthorized, true);
  for (const changes of [
    { nodeEnv: 'test' }, { confirmation: '' }, { expectedHost: 'other.neon.tech' },
    { expectedDatabase: 'other' }, { expectedDatabase: 'agromarket_test', databaseUrl: options.databaseUrl.replace('neondb', 'agromarket_test') },
    { databaseUrl: 'postgresql://fixture:fixture@localhost:5432/neondb' },
    { databaseUrl: options.databaseUrl + '&host=localhost' },
    { databaseUrl: options.databaseUrl.replace('sslmode=require', 'sslmode=disable') },
    { databaseUrl: options.databaseUrl.replace(':5432', ':5433') },
  ]) assert.throws(() => productionFarmerConfig({ ...options, ...changes }));
});

test('accepts the two Neon parameters without weakening TLS or channel binding', () => {
  const config = productionFarmerConfig({ ...options, databaseUrl: options.databaseUrl + '&channel_binding=require' });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.enableChannelBinding, true);
  for (const suffix of ['&channel_binding=disable', '&channel_binding=prefer',
    '&channel_binding=require&channel_binding=require', '&sslmode=require', '&host=other.invalid']) {
    assert.throws(() => productionFarmerConfig({ ...options, databaseUrl: options.databaseUrl + suffix }));
  }
  assert.throws(() => assertProductionChannelBinding(false, true));
  assert.doesNotThrow(() => assertProductionChannelBinding(true, true));
  assert.doesNotThrow(() => assertProductionChannelBinding(false, false));
});

test('tracks the negotiated SASL mechanism before pg clears its session', () => {
  for (const [mechanism, expected] of [['SCRAM-SHA-256', false], ['SCRAM-SHA-256-PLUS', true]]) {
    const client = { connection: new EventEmitter(), saslSession: { mechanism } };
    client.connection.on('authenticationSASLFinal', () => { client.saslSession = null; });
    const negotiated = trackProductionChannelBinding(client);
    client.connection.emit('authenticationSASLFinal');
    assert.equal(client.saslSession, null);
    assert.equal(negotiated(), expected);
  }
});

function mockClient({ database = 'neondb', readOnly = false, roles = ['user', 'admin'], extra = false, failAdd = false } = {}) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT current_database')) return { rows: [{ name: database, read_only: readOnly }] };
    if (sql.includes('pg_catalog.pg_attribute a') && !sql.includes('pg_constraint')) return { rows: [{ type: 'text', attnotnull: true }] };
    if (sql.includes('pg_catalog.pg_constraint')) {
      const definition = `CHECK ((role = ANY (ARRAY[${roles.map((role) => `'${role}'::text`).join(', ')}])))`;
      const row = { conname: 'users_role_check', convalidated: true, definition };
      return { rows: extra ? [row, row] : [row] };
    }
    if (failAdd && sql.includes('ADD CONSTRAINT')) throw new Error('Simulated failure');
    return { rows: [] };
  } };
}

test('changes only the expected role constraint in a transaction', async () => {
  const client = mockClient();
  assert.deepEqual(await migrateProductionFarmerRole(client, options), { changed: true });
  assert.equal(client.calls.filter((sql) => sql.startsWith('ALTER TABLE')).length, 2);
  assert.equal(client.calls.at(-1), 'COMMIT');
  assert.ok(client.calls.indexOf('LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE') < client.calls.findIndex((sql) => sql.includes('pg_constraint')));
});

test('already migrated constraint is left unchanged', async () => {
  const client = mockClient({ roles: ['user', 'admin', 'farmer'] });
  assert.deepEqual(await migrateProductionFarmerRole(client, options), { changed: false });
  assert.ok(!client.calls.some((sql) => sql.startsWith('ALTER TABLE')));
});

test('refuses a mismatched database or read-only target before BEGIN', async () => {
  const invalid = mockClient();
  await assert.rejects(migrateProductionFarmerRole(invalid, { ...options, nodeEnv: 'test' }));
  assert.equal(invalid.calls.length, 0);
  for (const data of [{ database: 'other' }, { readOnly: true }]) {
    const client = mockClient(data);
    await assert.rejects(migrateProductionFarmerRole(client, options));
    assert.ok(!client.calls.includes('BEGIN'));
  }
});

test('unexpected constraints and DDL failures roll back', async () => {
  for (const data of [{ roles: ['user', 'admin', 'other'] }, { extra: true }, { failAdd: true }]) {
    const client = mockClient(data);
    await assert.rejects(migrateProductionFarmerRole(client, options));
    assert.equal(client.calls.at(-1), 'ROLLBACK');
  }
});
