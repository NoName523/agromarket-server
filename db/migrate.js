import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { assertSafeMigrationTarget } from './migration-target.js';

const statements = [
  `CREATE TABLE IF NOT EXISTS public.login_attempts (
    email_key TEXT PRIMARY KEY CHECK (email_key ~ '^[0-9a-f]{64}$'),
    generation UUID NOT NULL,
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count BETWEEN 0 AND 10),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    blocked_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '16 minutes'),
    CHECK (expires_at > window_started_at),
    CHECK (blocked_until IS NULL OR
      (failed_count = 10 AND blocked_until >= window_started_at AND blocked_until <= expires_at)),
    CHECK (failed_count < 10 OR blocked_until IS NOT NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS public.login_attempt_reservations (
    email_key TEXT NOT NULL REFERENCES public.login_attempts(email_key) ON DELETE CASCADE,
    attempt_id UUID NOT NULL,
    generation UUID NOT NULL,
    reserved_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL CHECK (lease_expires_at > reserved_at),
    PRIMARY KEY (email_key, attempt_id)
  )`,
  `CREATE INDEX IF NOT EXISTS login_attempts_expiry_idx
    ON public.login_attempts (expires_at, email_key)`,
  `CREATE INDEX IF NOT EXISTS login_attempt_reservations_lease_idx
    ON public.login_attempt_reservations (email_key, lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT,
    price INTEGER NOT NULL CHECK (price >= 0), unit TEXT NOT NULL DEFAULT 'кг',
    image TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user'
      CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
    quantity INTEGER NOT NULL CHECK (quantity >= 10), delivery_date DATE, comment TEXT,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'processing', 'done', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

let client;
try {
  const database = assertSafeMigrationTarget({ databaseUrl: process.env.DATABASE_URL });
  client = await pool.connect();
  const { rows } = await client.query('SELECT current_database() AS name');
  if (rows[0]?.name !== database) throw new Error('Connected database differs from the validated target.');
  await client.query('BEGIN');
  for (const statement of statements) await client.query(statement);
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    const passwordHash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('AgroMarket admin', $1, $2, 'admin') ON CONFLICT (email) DO NOTHING`,
      [email, passwordHash],
    );
  }
  await client.query('COMMIT');
  console.log(`Database migration completed for ${database}.`);
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(error.message || 'Database migration failed.');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
