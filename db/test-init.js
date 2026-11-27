import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { pool } from './pool.js';
import { applyOrdersMigration } from './migrate-orders.js';
import { assertTestInitConfiguration, assertTestInitTarget, dropTestSchemaSafely } from './test-init-guard.js';

let client;
let transactionStarted = false;

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  assertTestInitConfiguration({ databaseUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV });

  client = await pool.connect();
  await assertTestInitTarget(client);

  const { products } = JSON.parse(await readFile(new URL('../data/db.json', import.meta.url), 'utf8'));
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('Test product fixtures are missing');
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8) {
    throw new Error('Test admin credentials are not configured');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');

  await client.query('BEGIN');
  transactionStarted = true;
  await dropTestSchemaSafely(client);
  await client.query('CREATE SCHEMA public');
  await client.query('SET LOCAL search_path TO public');
  await client.query(schema);
  await applyOrdersMigration(client);
  for (const product of products) {
    const inferredUnit = product.name.match(/,\s*\d+(?:[.,]\d+)?\s*(кг|л|РєРі|Р»)\s*$/iu)?.[1];
    const unit = product.unit ?? (inferredUnit === 'РєРі' ? 'кг' : inferredUnit === 'Р»' ? 'л' : inferredUnit);
    if (!unit) throw new Error(`Missing unit for test product ${product.id}`);
    await client.query(
      `INSERT INTO products (name, category, price, unit, image)
       VALUES ($1, $2, $3, $4, $5)`,
      [product.name, product.category ?? null, Number(product.price),
        unit, product.image ?? null],
    );
  }
  await client.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('AgroMarket test admin', $1, $2, 'admin')`,
    [email, passwordHash],
  );
  await client.query('COMMIT');
  transactionStarted = false;
  console.log(`Test database initialized with ${products.length} products and one admin.`);
} catch (error) {
  if (transactionStarted && client) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the safe error below */ }
  }
  console.error(error.message || 'Test database initialization failed.');
  process.exitCode = 1;
} finally {
  if (client) client.release();
  await pool.end();
}
