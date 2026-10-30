import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { getAdminToken, getUserToken } from './helpers.js';

describe('Administrative product access', () => {
  let userToken;
  let adminToken;
  beforeAll(async () => {
    userToken = await getUserToken();
    adminToken = await getAdminToken();
  });

  it('rejects a request without a token with HTTP 401', async () => {
    expect((await request(app).post('/api/products').send({ name: 'Honey', price: 1 })).status).toBe(401);
  });

  it('rejects an invalid JWT with HTTP 401', async () => {
    const token = jwt.sign({ sub: '1', role: 'admin' }, 'wrong-secret');
    expect((await request(app).post('/api/products').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Honey', price: 1 })).status).toBe(401);
  });

  it('forbids a regular user from creating or deleting products', async () => {
    expect((await request(app).post('/api/products').set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Honey', price: 1 })).status).toBe(403);
    expect((await request(app).delete('/api/products/1')
      .set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  });

  it('allows an administrator to create, update, and delete a product', async () => {
    const auth = `Bearer ${adminToken}`;
    const created = await request(app).post('/api/products').set('Authorization', auth)
      .send({ name: 'Test Honey', category: 'Honey', price: 2500, unit: 'kg' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const updated = await request(app).put(`/api/products/${id}`).set('Authorization', auth)
      .send({ name: 'Test Honey', category: 'Honey', price: 2700, unit: 'kg' });
    expect(updated.status).toBe(200);
    expect(Number(updated.body.price)).toBe(2700);
    expect((await request(app).delete(`/api/products/${id}`).set('Authorization', auth)).status).toBe(204);
    expect((await request(app).get(`/api/products/${id}`)).status).toBe(404);
  });
});

describe('Administrative order access', () => {
  it('requires a token and forbids regular users from the admin order list', async () => {
    expect((await request(app).get('/api/orders')).status).toBe(401);
    const token = await getUserToken();
    expect((await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('allows administrators to read the order list', async () => {
    const token = await getAdminToken();
    const response = await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
