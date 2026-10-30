import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { getUserToken } from './helpers.js';

describe('GET /api/orders/my', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/orders/my')).status).toBe(401);
  });

  it('returns only the authenticated user’s orders', async () => {
    const [firstToken, secondToken] = await Promise.all([getUserToken(), getUserToken()]);
    const createOrder = (token, name) => request(app).post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, email: `${name}@test.invalid`, quantity: 10 });
    expect((await createOrder(firstToken, 'First Buyer')).status).toBe(201);
    expect((await createOrder(secondToken, 'Second Buyer')).status).toBe(201);

    const response = await request(app).get('/api/orders/my')
      .set('Authorization', `Bearer ${firstToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].name).toBe('First Buyer');
  });
});
