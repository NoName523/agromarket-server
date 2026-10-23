import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.JWT_EXPIRES_IN = '2h';

const { pool } = await import('../db/pool.js');
const { default: authRouter } = await import('../routes/auth.js');
const { default: productsRouter } = await import('../routes/products.js');
const { default: ordersRouter } = await import('../routes/orders.js');
const { errorHandler } = await import('../middleware/errorHandler.js');

test('границы доступа работают без обращения к рабочей БД', async () => {
  const originalQuery = pool.query;
  const queries = [];
  pool.query = async (sql, values) => {
    queries.push(sql);
    if (sql.includes('FROM public.users WHERE id = $1')) {
      assert.doesNotMatch(sql, /password_hash/i);
      return { rows: values[0] === 2 ? [{
        id: 2, name: 'Айгерим', email: 'user@example.test', role: 'user',
        created_at: '2026-10-16T00:00:00.000Z',
      }] : [] };
    }
    if (sql.includes('FROM public.products')) {
      return { rows: [{ id: 1, name: 'Товар' }] };
    }
    if (sql.includes('FROM public.orders')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.products')) {
      return { rows: [{ id: 5, name: 'Товар', price: 100 }] };
    }
    if (sql.includes('UPDATE public.products')) {
      return { rows: [{ id: 1, name: 'Товар', price: 100 }] };
    }
    if (sql.includes('DELETE FROM public.products')) {
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE public.orders')) {
      return { rows: [{ id: 1, status: 'done', delivery_date: null, created_at: null }] };
    }
    throw new Error('Неожиданный SQL в тесте');
  };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/orders', ordersRouter);
  app.use(errorHandler);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const userToken = jwt.sign({ role: 'user' }, process.env.JWT_SECRET,
    { subject: '2', expiresIn: '2h' });
  const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET,
    { subject: '1', expiresIn: '2h' });
  const expiredToken = jwt.sign({ role: 'user' }, process.env.JWT_SECRET,
    { subject: '2', expiresIn: -1 });
  const invalidToken = jwt.sign({ role: 'admin' }, randomBytes(32),
    { subject: '1', expiresIn: '2h' });
  const request = async (path, method = 'GET', token, body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };

  try {
    assert.equal((await request('/api/auth/me')).status, 401);
    assert.equal((await request('/api/auth/me', 'GET', 'Bearer')).status, 401);
    assert.equal((await request('/api/auth/me', 'GET', `Bearer ${invalidToken}`)).status, 401);
    assert.equal((await request('/api/auth/me', 'GET', `Bearer ${expiredToken}`)).status, 401);

    const me = await request('/api/auth/me', 'GET', `Bearer ${userToken}`);
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body).sort(), ['created_at', 'email', 'id', 'name', 'role']);
    assert.equal((await request('/api/auth/me', 'GET', `Bearer ${adminToken}`)).status, 401);

    const beforeDenied = queries.length;
    assert.equal((await request('/api/products', 'POST', undefined,
      { name: 'Товар', price: 100 })).status, 401);
    assert.equal((await request('/api/products/1', 'PUT', undefined,
      { name: 'Товар', price: 100 })).status, 401);
    assert.equal((await request('/api/products/1', 'DELETE')).status, 401);
    assert.equal((await request('/api/orders')).status, 401);
    assert.equal((await request('/api/orders/1', 'PATCH', undefined,
      { status: 'done' })).status, 401);
    const denied = await request('/api/products', 'POST', `Bearer ${userToken}`,
      { name: 'Товар', price: 100 });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: 'Недостаточно прав' });
    assert.equal((await request('/api/products/1', 'PUT', `Bearer ${userToken}`,
      { name: 'Товар', price: 100 })).status, 403);
    assert.equal((await request('/api/products/1', 'DELETE', `Bearer ${userToken}`)).status, 403);
    assert.equal((await request('/api/orders', 'GET', `Bearer ${userToken}`)).status, 403);
    assert.equal((await request('/api/orders/1', 'PATCH', `Bearer ${userToken}`,
      { status: 'done' })).status, 403);
    assert.equal(queries.length, beforeDenied);

    assert.equal((await request('/api/products')).status, 200);
    assert.equal((await request('/api/products/1')).status, 200);
    assert.equal((await request('/api/orders', 'POST', undefined, {})).status, 400);
    assert.equal((await request('/api/products', 'POST', `Bearer ${adminToken}`,
      { name: 'Товар', price: 100 })).status, 201);
    assert.equal((await request('/api/products/1', 'PUT', `Bearer ${adminToken}`,
      { name: 'Товар', price: 100 })).status, 200);
    assert.equal((await request('/api/products/1', 'DELETE', `Bearer ${adminToken}`)).status, 204);
    assert.equal((await request('/api/orders', 'GET', `Bearer ${adminToken}`)).status, 200);
    assert.equal((await request('/api/orders/1', 'PATCH', `Bearer ${adminToken}`,
      { status: 'done' })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery;
    await pool.end();
  }
});
