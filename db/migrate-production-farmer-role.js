import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIRMATION = 'I_CONFIRM_PRODUCTION_FARMER_ROLE_MIGRATION';

export function productionFarmerConfig({ databaseUrl, nodeEnv, confirmation, expectedHost, expectedDatabase }) {
  if (nodeEnv !== 'production' || confirmation !== CONFIRMATION ||
      typeof expectedHost !== 'string' || typeof expectedDatabase !== 'string') {
    throw new Error('Production target confirmation is required.');
  }
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('Invalid production target.'); }
  const host = url.hostname.toLowerCase();
  let database, user, password;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { throw new Error('Invalid production target.'); }
  const entries = [...url.searchParams.entries()];
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(host) ||
      host !== expectedHost.toLowerCase() || Number(url.port || 5432) !== 5432 ||
      !database || database !== expectedDatabase || /test|dev|preview/i.test(database) ||
      !user || !password || url.hash ||
      entries.some(([key, value]) => !(key === 'sslmode' && ['require', 'verify-full'].includes(value)) &&
        !(key === 'channel_binding' && value === 'require')) ||
      new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error('Production target is not explicitly approved.');
  }
  return { host, port: 5432, database, user, password,
    ssl: { rejectUnauthorized: true }, enableChannelBinding: url.searchParams.get('channel_binding') === 'require',
    max: 1, connectionTimeoutMillis: 10000 };
}

export function trackProductionChannelBinding(client) {
  let negotiated = false;
  // pg clears saslSession after processing SASLFinal; observe it before that handler.
  client.connection.prependListener('authenticationSASLFinal', () => {
    negotiated = client.saslSession?.mechanism === 'SCRAM-SHA-256-PLUS';
  });
  return () => negotiated;
}

export function assertProductionChannelBinding(negotiated, required) {
  if (required && !negotiated) {
    throw new Error('Required channel binding was not negotiated.');
  }
}

function expectedRoleConstraint(definition) {
  const match = /^CHECK\s*\(\s*\(\s*role\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\)\s*\)\s*\)$/i.exec(definition || '');
  if (!match) return null;
  const entries = match[1].split(',').map((item) => /^\s*'([^']+)'(?:\s*::\s*text)?\s*$/i.exec(item)?.[1]);
  if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length) return null;
  if (entries.length === 2 && ['user', 'admin'].every((role) => entries.includes(role))) return 'old';
  if (entries.length === 3 && ['user', 'admin', 'farmer'].every((role) => entries.includes(role))) return 'current';
  return null;
}

export async function migrateProductionFarmerRole(client, options) {
  const { database: expectedDatabase } = productionFarmerConfig(options);
  let transaction = false;
  try {
    const target = await client.query('SELECT current_database() AS name, pg_is_in_recovery() AS read_only');
    if (target.rows[0]?.name !== expectedDatabase || target.rows[0]?.read_only !== false) {
      throw new Error('Connected database does not match the approved writable target.');
    }
    await client.query('BEGIN');
    transaction = true;
    await client.query('LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE');
    const column = await client.query(`SELECT a.attnotnull, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'role' AND NOT a.attisdropped`);
    if (column.rows.length !== 1 || column.rows[0].type !== 'text' || column.rows[0].attnotnull !== true) {
      throw new Error('Unexpected users role column.');
    }
    const constraints = await client.query(`SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'role' AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'public.users'::regclass AND c.contype = 'c'`);
    const constraint = constraints.rows[0];
    const state = expectedRoleConstraint(constraint?.definition);
    if (constraints.rows.length !== 1 || constraint.conname !== 'users_role_check' ||
        constraint.convalidated !== true || !state) throw new Error('Unexpected users role constraint.');
    if (state === 'old') {
      await client.query('ALTER TABLE public.users DROP CONSTRAINT users_role_check');
      await client.query("ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'farmer'))");
    }
    await client.query('COMMIT');
    transaction = false;
    return { changed: state === 'old' };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const options = { databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV, confirmation: process.env.CONFIRM_PRODUCTION_FARMER_MIGRATION,
    expectedHost: process.env.EXPECTED_PRODUCTION_DB_HOST, expectedDatabase: process.env.EXPECTED_PRODUCTION_DB_NAME };
  const config = productionFarmerConfig(options);
  const { default: pg } = await import('pg');
  const client = new pg.Client(config);
  const channelBound = trackProductionChannelBinding(client);
  try {
    await client.connect();
    assertProductionChannelBinding(channelBound(), config.enableChannelBinding);
    const result = await migrateProductionFarmerRole(client, options);
    console.log(result.changed ? 'Production role constraint updated.' : 'Production role constraint already updated.');
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {
    console.error('Production farmer migration failed; details are suppressed.');
    process.exitCode = 1;
  }
}
