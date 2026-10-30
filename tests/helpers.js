import request from 'supertest';
import app from '../app.js';

export function uniqueEmail(prefix = 'user') {
  return `${prefix}-${crypto.randomUUID()}@test.invalid`;
}

export async function getUserToken() {
  const response = await request(app).post('/api/auth/register').send({
    name: 'Test Buyer', email: uniqueEmail(), password: 'qwerty123',
  });
  return response.body.token;
}

export async function getAdminToken() {
  const response = await request(app).post('/api/auth/login').send({
    email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
  });
  return response.body.token;
}
