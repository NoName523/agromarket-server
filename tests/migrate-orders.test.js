import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateOrders, ordersMigrationConfig } from '../db/migrate-orders.js';

const local = {
  mode: 'local', nodeEnv: 'development',
  databaseUrl: 'postgres://fixture:fixture@127.0.0.1:5432/agromarket',
};
const isolated = {
  mode: 'test', nodeEnv: 'test', ci: 'false',
  databaseUrl: 'postgres://fixture:fixture@192.168.174.10:5432/agromarket_test',
};
const production = {
  mode: 'production', nodeEnv: 'production',
  databaseUrl: 'postgresql://fixture:fixture@ep-example.neon.tech/agromarket?sslmode=require',
  expectedHost: 'ep-example.neon.tech', expectedDatabase: 'agromarket',
  confirmation: 'I_CONFIRM_PRODUCTION_ORDERS_MIGRATION_013',
};

test('orders migration accepts only the configured target for each mode', () => {
  assert.equal(ordersMigrationConfig(local).database, 'agromarket');
  assert.equal(ordersMigrationConfig(isolated).database, 'agromarket_test');
  assert.equal(ordersMigrationConfig({
    ...isolated, ci: 'true', testDatabasePort: '5432',
    databaseUrl: 'postgres://fixture:fixture@localhost:5432/agromarket_test',
  }).host, 'localhost');
  assert.deepEqual(ordersMigrationConfig(production).ssl, { rejectUnauthorized: true });
  for (const options of [
    { ...local, databaseUrl: isolated.databaseUrl },
    { ...isolated, databaseUrl: local.databaseUrl },
    { ...isolated, ci: 'true', testDatabasePort: '5432' },
    { ...local, databaseUrl: production.databaseUrl },
    { ...local, databaseUrl: local.databaseUrl + '?host=outside.invalid' },
    { ...local, databaseUrl: local.databaseUrl.replace('5432', '5433') },
    { ...local, databaseUrl: local.databaseUrl.replace('fixture:fixture@', '') },
    { ...local, nodeEnv: 'production' },
    { ...local, confirmation: production.confirmation },
    { ...production, confirmation: undefined },
    { ...production, confirmation: 'I_CONFIRM_PRODUCTION_FARMER_ROLE_MIGRATION' },
    { ...production, expectedHost: 'ep-other.neon.tech' },
    { ...production, expectedDatabase: 'another_db' },
    { ...production, databaseUrl: production.databaseUrl + '&sslmode=disable' },
    { ...production, databaseUrl: production.databaseUrl + '&host=outside.invalid' },
  ]) {
    assert.throws(() => ordersMigrationConfig(options));
  }
});

const actualLocal = {
  database_name: 'agromarket', server_address: '127.0.0.1', server_port: 5432, writable: true,
};

function mockClient(target) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: [target] };
    },
  };
}

test('orders migration refuses a mismatched or read-only connection before DDL', async () => {
  const unapproved = mockClient(actualLocal);
  await assert.rejects(migrateOrders(unapproved, { ...production, confirmation: undefined }));
  assert.deepEqual(unapproved.calls, []);

  for (const [options, target] of [
    [local, { ...actualLocal, database_name: 'other' }],
    [local, { ...actualLocal, server_address: '10.0.0.2' }],
    [local, { ...actualLocal, server_port: 5433 }],
    [local, { ...actualLocal, writable: false }],
    [isolated, { ...actualLocal, database_name: 'agromarket_test' }],
    [production, { ...actualLocal, writable: false }],
  ]) {
    const client = mockClient(target);
    await assert.rejects(migrateOrders(client, options), /refused|approved writable target/);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0], /current_database\(\)/);
  }
});

test('orders migration submits 013 as one atomic statement after checking the connection', async () => {
  const client = mockClient(actualLocal);
  await migrateOrders(client, local);
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0], /current_database\(\)/);
  assert.match(client.calls[1], /DO \$migration\$/);
  assert.match(client.calls[1], /CREATE TABLE public\.purchase_orders/);
  assert.doesNotMatch(client.calls[1], /ALTER TABLE public\.orders RENAME/);
});
