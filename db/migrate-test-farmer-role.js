import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { assertTestInitConfiguration, assertTestInitTarget } from './test-init-guard.js';

const TEST_DATABASE_PORT = '5432';

function readAllowedRoles(definition) {
  const match = /^check\s*\(\s*\(\s*role\s*=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)\s*\)\s*\)$/i
    .exec(definition.trim());
  if (!match) return null;

  const entries = match[1].split(',').map((entry) => /^\s*'([^']*)'(?:\s*::\s*text)?\s*$/i.exec(entry));
  if (entries.some((entry) => !entry)) return null;
  return entries.map((entry) => entry[1]);
}

export function assertTestFarmerMigrationConfiguration({ databaseUrl, nodeEnv }) {
  assertTestInitConfiguration({
    databaseUrl,
    nodeEnv,
    // This migration is only for the local VMware test PostgreSQL, never CI or production.
    ci: 'false',
    testDatabasePort: TEST_DATABASE_PORT,
  });
  const url = new URL(databaseUrl);
  if (url.search || url.hash || databaseUrl.includes('?') || databaseUrl.includes('#')) {
    throw new Error('Connection URL query parameters and fragments are not allowed.');
  }
}

export function testFarmerPoolConfiguration({ databaseUrl, nodeEnv }) {
  assertTestFarmerMigrationConfiguration({ databaseUrl, nodeEnv });
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!user || !password) throw new Error('Test database credentials must be explicit.');
  return {
    host: url.hostname, port: Number(url.port || TEST_DATABASE_PORT),
    database: decodeURIComponent(url.pathname.slice(1)), user, password,
    ssl: false, max: 1, connectionTimeoutMillis: 10000,
  };
}

export async function assertTestFarmerMigrationTarget(client, nodeEnv) {
  await assertTestInitTarget(client, {
    nodeEnv,
    ci: 'false',
    testDatabasePort: TEST_DATABASE_PORT,
  });
}

export async function runTestFarmerRoleMigration({ pool, databaseUrl, nodeEnv }) {
  assertTestFarmerMigrationConfiguration({ databaseUrl, nodeEnv });

  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    // Validate actual server/database identity before any DDL starts.
    await assertTestFarmerMigrationTarget(client, nodeEnv);

    await client.query('BEGIN');
    transactionStarted = true;

    const { rows: tableRows } = await client.query(
      "SELECT to_regclass('public.users') AS users_table",
    );
    if (!tableRows[0]?.users_table) {
      throw new Error('The expected public.users table does not exist.');
    }

    const { rows: constraints } = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.users'::regclass
        AND conname = 'users_role_check'
        AND contype = 'c'
    `);
    const definition = constraints[0]?.definition;
    const roles = definition ? readAllowedRoles(definition) : null;
    const roleSet = new Set(roles ?? []);
    const isExpectedConstraint = roles && roleSet.size === roles.length &&
      roles.length === 2 && roleSet.has('user') && roleSet.has('admin');
    const isFarmerConstraint = roles && roleSet.size === roles.length &&
      roles.length === 3 && roleSet.has('user') && roleSet.has('admin') && roleSet.has('farmer');
    if (!isExpectedConstraint && !isFarmerConstraint) {
      throw new Error('The expected users_role_check constraint was not found.');
    }

    if (isFarmerConstraint) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { changed: false };
    }

    await client.query('ALTER TABLE public.users DROP CONSTRAINT users_role_check');
    await client.query(`
      ALTER TABLE public.users
      ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'farmer'))
    `);
    await client.query('COMMIT');
    transactionStarted = false;
    return { changed: true };
  } catch (error) {
    if (transactionStarted && client) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the migration error */ }
    }
    throw error;
  } finally {
    client?.release();
  }
}

async function runFromCommandLine() {
  const envPath = fileURLToPath(new URL('../.env.test', import.meta.url));
  const loaded = dotenv.config({ path: envPath, override: true, quiet: true });
  if (loaded.error) {
    throw new Error('The isolated backend .env.test could not be loaded.');
  }

  const config = testFarmerPoolConfiguration({
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
  });
  const { default: pg } = await import('pg');
  const pool = new pg.Pool(config);
  try {
    const result = await runTestFarmerRoleMigration({
      pool,
      databaseUrl: process.env.DATABASE_URL,
      nodeEnv: process.env.NODE_ENV,
    });
    console.log(result.changed
      ? 'Test database farmer role constraint updated.'
      : 'Test database farmer role constraint is already present.');
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runFromCommandLine();
  } catch {
    console.error('Test farmer role migration failed; connection details are suppressed.');
    process.exitCode = 1;
  }
}
