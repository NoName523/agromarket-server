import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { assertTestFarmerMigrationConfiguration, assertTestFarmerMigrationTarget,
  testFarmerPoolConfiguration } from './migrate-test-farmer-role.js';

export async function seedTestFarmer({ pool, databaseUrl, nodeEnv, email, password }) {
  assertTestFarmerMigrationConfiguration({ databaseUrl, nodeEnv });
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254 ||
      typeof password !== 'string' || password.length < 8 || password.length > 72 ||
      Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Invalid test farmer credentials.');
  }
  let client;
  try {
    client = await pool.connect();
    await assertTestFarmerMigrationTarget(client, nodeEnv);
    const hash = await bcrypt.hash(password, 10);
    const inserted = await client.query(
      `INSERT INTO public.users (name, email, password_hash, role)
       VALUES ('E2E test farmer', $1, $2, 'farmer')
       ON CONFLICT (email) DO NOTHING RETURNING id`, [cleanEmail, hash],
    );
    if (inserted.rowCount === 1) return { created: true };
    const existing = await client.query(
      'SELECT role, password_hash FROM public.users WHERE email = $1', [cleanEmail],
    );
    if (existing.rows[0]?.role !== 'farmer' ||
        !(await bcrypt.compare(password, existing.rows[0].password_hash))) {
      throw new Error('Existing account is not the configured test farmer.');
    }
    return { created: false };
  } finally {
    client?.release();
  }
}

async function main() {
  const loaded = dotenv.config({ path: fileURLToPath(new URL('../.env.test', import.meta.url)),
    override: true, quiet: true });
  if (loaded.error) throw new Error('Test configuration unavailable.');
  const { DATABASE_URL: databaseUrl, NODE_ENV: nodeEnv,
    E2E_FARMER_EMAIL: email, E2E_FARMER_PASSWORD: password } = process.env;
  const config = testFarmerPoolConfiguration({ databaseUrl, nodeEnv });
  const { default: pg } = await import('pg');
  const pool = new pg.Pool(config);
  try {
    const result = await seedTestFarmer({ pool, databaseUrl, nodeEnv, email, password });
    console.log(result.created ? 'Test farmer created.' : 'Test farmer already exists.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {
    console.error('Test farmer seed failed; details are suppressed.');
    process.exitCode = 1;
  }
}
