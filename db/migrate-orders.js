import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestInitConfiguration, assertTestInitTarget } from './test-init-guard.js';
import {
  neonMigrationConfig, trackProductionChannelBinding, assertProductionChannelBinding,
} from './migrate-production-farmer-role.js';

const PRODUCTION_CONFIRMATION = 'I_CONFIRM_PRODUCTION_ORDERS_MIGRATION_013';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const VM_HOST = '192.168.174.10';

export function ordersMigrationConfig(options) {
  const { mode, databaseUrl, nodeEnv, ci, testDatabasePort } = options;
  if (mode === 'production') return neonMigrationConfig(options, PRODUCTION_CONFIRMATION);

  if ((mode !== 'local' && mode !== 'test') ||
      nodeEnv !== (mode === 'test' ? 'test' : 'development') || options.confirmation) {
    throw new Error('Orders migration mode and environment do not match.');
  }

  let url, user, password, database;
  try {
    url = new URL(databaseUrl);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('Invalid PostgreSQL migration target.');
  }
  const port = Number(url.port || 5432);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || /[?#]/.test(databaseUrl) ||
      !user || !password || port !== 5432) {
    throw new Error('Orders migration requires explicit PostgreSQL credentials and port 5432.');
  }

  if (mode === 'test') {
    assertTestInitConfiguration({ databaseUrl, nodeEnv, ci, testDatabasePort });
  } else if (database !== 'agromarket' || ![...LOOPBACK, VM_HOST].includes(url.hostname)) {
    throw new Error('Local migration requires agromarket on loopback or the PostgreSQL VM.');
  }

  return {
    host: url.hostname === '[::1]' ? '::1' : url.hostname,
    port, database, user, password, ssl: false, connectionTimeoutMillis: 10000,
  };
}

export async function assertOrdersMigrationTarget(client, options, config) {
  if (options.mode === 'test') await assertTestInitTarget(client, options);

  const { rows: [target] } = await client.query(`
    SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address,
      inet_server_port() AS server_port, current_setting('transaction_read_only') = 'off' AS writable
  `);
  const expectedAddress = config.host === 'localhost'
    ? ['127.0.0.1', '::1'].includes(target?.server_address)
    : target?.server_address === config.host;
  if (target?.database_name !== config.database || target?.writable !== true ||
      (options.mode === 'local' && (!expectedAddress || target.server_port !== config.port))) {
    throw new Error('Connected database does not match the approved writable target.');
  }
}

export async function applyOrdersMigration(client) {
  const sql = await readFile(new URL('./migrations/013_orders.sql', import.meta.url), 'utf8');
  await client.query(sql);
}

export async function migrateOrders(client, options) {
  const config = ordersMigrationConfig(options);
  await assertOrdersMigrationTarget(client, options, config);
  await applyOrdersMigration(client);
}

async function main() {
  const options = {
    mode: process.argv[2],
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    confirmation: process.env.CONFIRM_PRODUCTION_ORDERS_MIGRATION,
    expectedHost: process.env.EXPECTED_PRODUCTION_DB_HOST,
    expectedDatabase: process.env.EXPECTED_PRODUCTION_DB_NAME,
    ci: process.env.CI,
    testDatabasePort: process.env.DB_TEST_PORT,
  };
  const config = ordersMigrationConfig(options);
  const { default: pg } = await import('pg');
  const client = new pg.Client(config);
  const channelBound = options.mode === 'production' ? trackProductionChannelBinding(client) : null;
  try {
    await client.connect();
    if (channelBound) assertProductionChannelBinding(channelBound(), config.enableChannelBinding);
    await migrateOrders(client, options);
    console.log('Orders migration 013 completed.');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = /^013: [a-z_ ,.]+$/i.test(error?.message) ? error.message : null;
    console.error(message ?? 'Orders migration 013 failed. Check target, schema and permissions. Connection details are suppressed.');
    process.exitCode = 1;
  }
}
