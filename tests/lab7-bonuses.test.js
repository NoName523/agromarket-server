import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = randomBytes(64).toString('base64url');
process.env.JWT_EXPIRES_IN = '2h';

const { pool } = await import('../db/pool.js');
const { default: app } = await import('../server.js');

test('бонусы и HTTP-защита работают с моками без PostgreSQL', async () => {
  const originalQuery = pool.query;
  const originalLog = console.log;
  const logs = [];
  const queries = [];
  let passwordHash = await bcrypt.hash('old-pass-123', 10);
  const insertedUserIds = [];
  pool.query = async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.includes('INSERT INTO public.orders')) {
      insertedUserIds.push(values[7]);
      return { rows: [{ id: insertedUserIds.length, user_id: values[7],
        delivery_date: null, created_at: null }] };
    }
    if (sql.includes('WHERE o.user_id = $1')) {
      assert.equal(values[0], 2);
      return { rows: [{ id: 2, user_id: 2, delivery_date: null, created_at: null }] };
    }
    if (sql.includes('SELECT password_hash FROM public.users')) {
      return { rows: [{ password_hash: passwordHash }] };
    }
    if (sql.includes('UPDATE public.users SET password_hash')) {
      assert.equal(values[1], 2);
      assert.equal(values[2], passwordHash);
      passwordHash = values[0];
      return { rows: [{ id: 2 }] };
    }
    if (sql.includes('FROM public.users WHERE email')) {
      return { rows: [{ id: 2, name: 'Тест', email: 'test@example.invalid',
        role: 'user', created_at: null, password_hash: passwordHash }] };
    }
    if (sql.includes('FROM public.products')) return { rows: [] };
    throw new Error('Неожиданный SQL');
  };
  console.log = (line) => logs.push(String(line));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ role: 'user' }, process.env.JWT_SECRET,
    { subject: '2', expiresIn: '2h' });
  const send = (path, options = {}) => fetch(base + path, options);
  const json = (method, body, auth) => ({
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
  const order = { name: 'Тест', email: 'test@example.invalid', quantity: 20 };

  try {
    assert.equal((await send('/api/products')).status, 200);
    const preflight = await send('/api/products', { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
    assert.equal((await send('/api/products')).headers.get('x-content-type-options'), 'nosniff');

    const large = await send('/api/orders', json('POST', { comment: 'a'.repeat(17000) }));
    assert.equal(large.status, 413);
    assert.equal((await large.json()).error, 'Слишком большое тело запроса');

    assert.equal((await send('/api/orders/my')).status, 401);
    const myOrders = await send('/api/orders/my', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(myOrders.status, 200);
    assert.deepEqual((await myOrders.json()).map((row) => row.user_id), [2]);
    assert.equal((await send('/api/orders', json('POST', order))).status, 201);
    assert.equal((await send('/api/orders', json('POST', order, `Bearer ${token}`))).status, 201);
    const beforeInvalid = queries.length;
    assert.equal((await send('/api/orders', json('POST', order, 'Bearer invalid.jwt.signature'))).status, 401);
    assert.equal((await send('/api/orders', json('POST', order, 'Basic invalid'))).status, 401);
    assert.equal(queries.length, beforeInvalid);
    assert.deepEqual(insertedUserIds, [null, 2]);

    assert.equal((await send('/api/auth/password', json('PATCH',
      { oldPassword: 'wrong', newPassword: 'new-pass-123' }, `Bearer ${token}`))).status, 401);
    assert.equal((await send('/api/auth/password', json('PATCH',
      { oldPassword: 'old-pass-123', newPassword: 'short' }, `Bearer ${token}`))).status, 400);
    assert.equal((await send('/api/auth/password', json('PATCH',
      { oldPassword: 'old-pass-123', newPassword: 'new-pass-123' }, `Bearer ${token}`))).status, 200);
    assert.equal(await bcrypt.compare('new-pass-123', passwordHash), true);

    assert.equal((await send('/api/auth/login', json('POST',
      { email: 'test@example.invalid', password: 'new-pass-123' }))).status, 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await send('/api/auth/login', json('POST',
        { email: 'test@example.invalid', password: 'wrong' }))).status, 401);
    }
    assert.equal((await send('/api/auth/login', json('POST',
      { email: 'test@example.invalid', password: 'wrong' }))).status, 429);
    assert.ok(logs.every((line) => !line.includes(token) && !line.includes('new-pass-123')));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery;
    console.log = originalLog;
    await pool.end();
  }
});
