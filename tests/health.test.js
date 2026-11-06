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
    expect(response.body).toMatchObject({ status: 'ok', db: 'connected', version: 'local' });
  });

  it('allows a configured CORS origin and rejects an unconfigured one', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', process.env.CORS_ORIGIN.split(',')[0].trim());
    expect(allowed.headers['access-control-allow-origin']).toBe(process.env.CORS_ORIGIN.split(',')[0].trim());
    const denied = await request(app).get('/api/health').set('Origin', 'https://not-allowed.invalid');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
