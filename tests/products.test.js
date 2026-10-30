import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('Public product catalog', () => {
  it('returns a non-empty product list with HTTP 200', async () => {
    const response = await request(app).get('/api/products');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('returns products with the expected fields', async () => {
    const response = await request(app).get('/api/products');
    expect(response.status).toBe(200);
    expect(response.body[0]).toHaveProperty('id');
    expect(response.body[0]).toHaveProperty('name');
    expect(response.body[0]).toHaveProperty('price');
  });

  it('returns the same product when fetched by id', async () => {
    const list = await request(app).get('/api/products');
    const detail = await request(app).get(`/api/products/${list.body[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe(list.body[0].name);
  });

  it('returns 404 for a missing product', async () => {
    const response = await request(app).get('/api/products/999999');
    expect(response.status).toBe(404);
  });
});
