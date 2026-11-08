import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('GET /api/categories', () => {
  it('returns public categories with positive integer counts', async () => {
    const response = await request(app).get('/api/categories');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
    for (const category of response.body) {
      // Existing products may have no category; SQL groups them under null.
      expect(category.name === null || typeof category.name === 'string').toBe(true);
      expect(Number.isInteger(category.count)).toBe(true);
      expect(category.count).toBeGreaterThan(0);
    }
  });

  it('counts every catalog page, including uncategorized products', async () => {
    const categories = await request(app).get('/api/categories');
    expect(categories.status).toBe(200);
    const products = [];
    // Small pages exercise pagination even with the small seed catalog.
    const limit = 2;
    for (let offset = 0; ; offset += limit) {
      const page = await request(app).get('/api/products').query({ limit, offset });
      expect(page.status).toBe(200);
      expect(Array.isArray(page.body)).toBe(true);
      products.push(...page.body);
      if (page.body.length < limit) break;
    }
    expect(categories.body.reduce((sum, category) => sum + category.count, 0))
      .toBe(products.length);
    const counts = new Map();
    for (const product of products) {
      counts.set(product.category, (counts.get(product.category) || 0) + 1);
    }
    expect(categories.body).toHaveLength(counts.size);
    for (const category of categories.body) {
      expect(category.count).toBe(counts.get(category.name));
    }
  });
});
