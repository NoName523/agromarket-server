import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('Server availability', () => {
  it('serves the root health page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('AgroMarket');
  });

  it('reports the database connection as healthy', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', db: 'connected' });
  });
});
