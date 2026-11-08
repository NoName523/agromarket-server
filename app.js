import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pool } from './db/pool.js';
import productsRouter from './routes/products.js';
import categoriesRouter from './routes/categories.js';
import ordersRouter from './routes/orders.js';
import authRouter from './routes/auth.js';
import { logger } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '16kb' }));
if (process.env.NODE_ENV !== 'test') app.use(logger);

app.get('/', (req, res) => res.send('AgroMarket API is running'));

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  const commit = process.env.RENDER_GIT_COMMIT;
  res.json({ status: 'ok', db: 'connected', version: commit?.slice(0, 7) || 'local' });
});

app.get('/api/about', (req, res) => {
  res.json({ name: 'AgroMarket', version: '1.0', author: 'AgroMarket' });
});

app.use('/api/products', productsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});
app.use(errorHandler);

export default app;
