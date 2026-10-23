import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

test('повторная ротация с тем же паролем не выполняет UPDATE', async () => {
  process.env.ADMIN_EMAIL = 'admin@example.invalid';
  process.env.ADMIN_PASSWORD = 'already-installed-test-password';
  const { pool } = await import('../db/pool.js');
  const originalQuery = pool.query;
  const originalEnd = pool.end;
  const originalLog = console.log;
  const originalArg = process.argv[2];
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  const logs = [];
  let updates = 0;

  pool.query = async (sql) => {
    if (sql.includes('current_database()')) return { rows: [{ name: 'agromarket' }] };
    if (sql.includes('SELECT id, password_hash')) return { rows: [{ id: 1, password_hash: hash }] };
    if (sql.includes('UPDATE')) updates += 1;
    throw new Error('Unexpected SQL');
  };
  pool.end = async () => {};
  console.log = (message) => logs.push(message);
  process.argv[2] = '--confirm';
  try {
    await import('../db/rotate-admin-password.js?idempotent-test');
    assert.equal(updates, 0);
    assert.match(logs.join(' '), /изменений нет/);
    assert.ok(logs.every((line) => !line.includes(process.env.ADMIN_PASSWORD)));
  } finally {
    pool.query = originalQuery;
    pool.end = originalEnd;
    console.log = originalLog;
    process.argv[2] = originalArg;
  }
});
