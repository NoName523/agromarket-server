import 'dotenv/config';
import app from './app.js';

const production = process.env.NODE_ENV === 'production';
const required = ['DATABASE_URL', 'JWT_SECRET'];
if (production) required.push('CORS_ORIGIN');
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length || (production && process.env.JWT_SECRET.length < 32)) {
  console.error(`Missing or invalid environment configuration: ${missing.join(', ') || 'JWT_SECRET must be at least 32 characters in production'}`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`AgroMarket API listening on port ${PORT}`);
});
let shuttingDown = false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async (error) => {
    try { const { pool } = await import('./db/pool.js'); await pool.end(); }
    catch { console.error('Failed to close PostgreSQL pool.'); }
    if (error) { console.error('Failed to close HTTP server.'); process.exitCode = 1; }
  });
});
