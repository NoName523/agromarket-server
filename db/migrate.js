import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

function assertSafeTarget(rawUrl) {
  if (!rawUrl) throw new Error('DATABASE_URL is required.');
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  const localHost = ['localhost', '127.0.0.1', '::1', '192.168.174.10'].includes(url.hostname);
  const testDatabase = database === 'agromarket_test';
  const vmDatabase = database === 'agromarket' && url.hostname === '192.168.174.10';
  if (process.env.NODE_ENV === 'production' || !localHost || !(testDatabase || vmDatabase)) {
    throw new Error('db is restricted to agromarket_test or agromarket on PostgreSQL VM 192.168.174.10, outside production.');
  }
  return database;
}

const statements = [
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
  const database = assertSafeTarget(process.env.DATABASE_URL);
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
