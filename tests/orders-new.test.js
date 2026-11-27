import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import app from '../app.js';
import legacyRouter from '../routes/order-requests.js';
import { applyOrdersMigration } from '../db/migrate-orders.js';
import { pool } from '../db/pool.js';

describe('Orders checkout', () => {
  let buyer, other, farmer, otherFarmer, product, secondProduct;
  const auth = (id, role) => `Bearer ${jwt.sign({ role }, process.env.JWT_SECRET, { subject: String(id) })}`;
  const payload = (items) => ({ address: 'Test address', items });

  beforeAll(async () => {
    const users = [];
    for (const role of ['user', 'user', 'farmer', 'farmer']) {
      const { rows: [user] } = await pool.query(
        'INSERT INTO public.users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id',
        ['Order test', randomUUID() + '@test.invalid', 'test-hash', role]);
      users.push(user.id);
    }
    [buyer, other, farmer, otherFarmer] = users;
    const { rows } = await pool.query(
      "INSERT INTO public.products (name,price,stock,farmer_id) VALUES ('Order test A',13,10,$1),('Order test B',7,10,$2) RETURNING id",
      [farmer, otherFarmer]);
    [product, secondProduct] = rows.map((row) => row.id);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM public.purchase_orders WHERE user_id = ANY($1::int[])', [[buyer, other]]);
    await pool.query('DELETE FROM public.products WHERE id = ANY($1::int[])', [[product, secondProduct]]);
    await pool.query('DELETE FROM public.users WHERE id = ANY($1::int[])', [[buyer, other, farmer, otherFarmer]]);
  });

  it('validates authorization, items, address and stock', async () => {
    expect((await request(app).post('/api/orders').send(payload([]))).status).toBe(401);
    expect((await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user')).send(payload([]))).status).toBe(400);
    for (const address of ['  abcd  ', 'x'.repeat(201)]) {
      expect((await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user'))
        .send({ address, items: [{ productId: product, quantity: 1 }] })).status).toBe(400);
    }
    expect((await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user'))
      .send(payload([{ productId: 2147483647, quantity: 1 }]))).status).toBe(404);
    const failed = await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user'))
      .send(payload([{ productId: product, quantity: 1 }, { productId: secondProduct, quantity: 11 }]));
    expect(failed.status).toBe(409);
    expect(failed.body.details).toMatchObject({ productId: secondProduct, available: 10 });
    const { rows } = await pool.query('SELECT stock FROM public.products WHERE id = ANY($1::int[]) ORDER BY id', [[product, secondProduct]]);
    expect(rows.map((row) => row.stock)).toEqual([10, 10]);
  });

  it('uses database prices, combines items, isolates buyers and farmers, and cancels once', async () => {
    const created = await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user'))
      .send({ ...payload([{ productId: product, quantity: 1 }, { productId: product, quantity: 2 },
        { productId: secondProduct, quantity: 1 }]), total_price: 1 });
    expect(created.status).toBe(201);
    expect(Number(created.body.total_price)).toBe(46);
    expect(created.body.status).toBe('new');
    const mine = await request(app).get('/api/orders/my').set('Authorization', auth(buyer, 'user'));
    expect(mine.body.find((order) => order.id === created.body.id).items).toHaveLength(2);
    const otherOrders = await request(app).get('/api/orders/my').set('Authorization', auth(other, 'user'));
    expect(otherOrders.body.some((order) => order.id === created.body.id)).toBe(false);
    expect((await request(app).get('/api/orders/incoming').set('Authorization', auth(buyer, 'user'))).status).toBe(403);
    const incoming = await request(app).get('/api/orders/incoming').set('Authorization', auth(farmer, 'farmer'));
    const items = incoming.body.filter((item) => item.order_id === created.body.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ product_id: product, quantity: 3, buyer_name: 'Order test',
      address: 'Test address', product_name: 'Order test A', unit_price: 13 });
    expect(items[0]).not.toHaveProperty('email');
    expect(items[0]).not.toHaveProperty('phone');
    expect((await request(app).post(`/api/orders/${created.body.id}/cancel`)
      .set('Authorization', auth(other, 'user'))).status).toBe(404);
    expect((await request(app).post(`/api/orders/${created.body.id}/cancel`)
      .set('Authorization', auth(buyer, 'user'))).status).toBe(200);
    expect((await request(app).post(`/api/orders/${created.body.id}/cancel`)
      .set('Authorization', auth(buyer, 'user'))).status).toBe(409);
    const { rows: [restored] } = await pool.query('SELECT stock FROM public.products WHERE id=$1', [product]);
    expect(restored.stock).toBe(10);
  });

  it('accepts address boundaries and forbids cancelling confirmed or shipped orders', async () => {
    for (const [address, status] of [['  abcde  ', 'confirmed'], ['x'.repeat(200), 'shipped']]) {
      const created = await request(app).post('/api/orders').set('Authorization', auth(buyer, 'user'))
        .send({ address, items: [{ productId: product, quantity: 1 }] });
      expect(created.status).toBe(201);
      expect(created.body.address).toBe(address.trim());
      await pool.query('UPDATE public.purchase_orders SET status=$1 WHERE id=$2', [status, created.body.id]);
      expect((await request(app).post(`/api/orders/${created.body.id}/cancel`)
        .set('Authorization', auth(buyer, 'user'))).status).toBe(409);
    }
  });

  it('enforces address and status constraints in PostgreSQL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [address, status] of [['abcd', 'new'], ['x'.repeat(201), 'new'], ['valid', 'pending']]) {
        await client.query('SAVEPOINT invalid_order');
        await expect(client.query(
          'INSERT INTO public.purchase_orders (user_id,address,status,total_price) VALUES ($1,$2,$3,0)',
          [buyer, address, status],
        )).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT invalid_order');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('retains the old request API at /api/orders after repeating 013', async () => {
    const legacyApp = express();
    legacyApp.use(express.json());
    legacyApp.use('/api/orders', legacyRouter);
    const before = await pool.query(
      "INSERT INTO public.orders (name,email,quantity) VALUES ('Legacy','legacy@test.invalid',10) RETURNING id");
    const client = await pool.connect();
    try {
      await applyOrdersMigration(client);
      await applyOrdersMigration(client);
      const created = await request(legacyApp).post('/api/orders')
        .send({ name: 'Old client', email: 'old@test.invalid', quantity: 10 });
      expect(created.status).toBe(201);
      const list = await request(legacyApp).get('/api/orders').set('Authorization', auth(buyer, 'admin'));
      expect(list.status).toBe(200);
      expect(list.body.some((row) => row.id === before.rows[0].id)).toBe(true);
      expect(list.body.some((row) => row.id === created.body.id)).toBe(true);
      expect((await request(legacyApp).patch(`/api/orders/${created.body.id}`)
        .set('Authorization', auth(buyer, 'admin')).send({ status: 'processing' })).status).toBe(200);
      await pool.query('DELETE FROM public.orders WHERE id=ANY($1::int[])', [[before.rows[0].id, created.body.id]]);
    } finally {
      client.release();
    }
  });

  it('serializes concurrent purchases of the last unit behind a separate lock', async () => {
    await pool.query('UPDATE public.products SET stock=1 WHERE id=$1', [product]);
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM public.products WHERE id=$1 FOR UPDATE', [product]);
      const send = (id) => request(app).post('/api/orders').set('Authorization', auth(id, 'user'))
        .send(payload([{ productId: product, quantity: 1 }])).then((response) => response);
      const first = send(buyer);
      const second = send(other);
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline && waiting < 2) {
        await lock.query('SELECT pg_stat_clear_snapshot()');
        const { rows: [row] } = await lock.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%'");
        waiting = row.count;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await lock.query('COMMIT');
      const responses = await Promise.all([first, second]);
      expect(waiting).toBe(2);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const { rows: [row] } = await pool.query('SELECT stock FROM public.products WHERE id=$1', [product]);
      expect(row.stock).toBe(0);
    } finally {
      await lock.query('ROLLBACK').catch(() => {});
      lock.release();
    }
  }, 15000);
});
