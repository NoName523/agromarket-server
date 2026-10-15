import { Router } from 'express';
import { validateOrder } from '../middleware/validateOrder.js';
import { pool } from '../db/pool.js';

const router = Router();

// Сохраняем прежние поля ответа наряду с именами столбцов PostgreSQL.
function serializeOrder(order) {
  return { ...order, date: order.delivery_date, createdAt: order.created_at };
}

const ORDER_STATUSES = new Set(['new', 'processing', 'done', 'cancelled']);

router.get('/', async (req, res) => {
  const { status } = req.query;
  if (status !== undefined &&
      (typeof status !== 'string' || !ORDER_STATUSES.has(status))) {
    return res.status(400).json({
      error: 'Параметр status должен быть одним из: new, processing, done, cancelled',
    });
  }

  const { rows } = await pool.query(`
    SELECT o.*, p.name AS product_name
    FROM public.orders o
    LEFT JOIN public.products p ON p.id = o.product_id
    WHERE ($1::text IS NULL OR o.status = $1)
    ORDER BY o.created_at DESC, o.id DESC
  `, [status ?? null]);
  res.json(rows.map(serializeOrder));
});

router.post('/', validateOrder, async (req, res) => {
  const { name, email, phone, quantity, date, delivery_date, comment, product_id } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO public.orders (product_id, name, email, phone, quantity, delivery_date, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [product_id === undefined || product_id === null || product_id === '' ? null : Number(product_id),
      name, email, phone || null, Number(quantity), (date ?? delivery_date) || null, comment || null],
  );
  res.status(201).json(serializeOrder(rows[0]));
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    return res.status(400).json({ error: 'ID должен быть положительным целым числом в диапазоне INTEGER' });
  }
  const { status } = req.body || {};
  if (typeof status !== 'string' || !status.trim()) {
    return res.status(400).json({ error: 'Поле status обязательно и должно быть непустой строкой' });
  }
  // Допустимые значения проверяет CHECK, ошибку 23514 обрабатывает errorHandler.
  const { rows } = await pool.query(
    'UPDATE public.orders SET status = $1 WHERE id = $2 RETURNING *', [status, id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(serializeOrder(rows[0]));
});

export default router;
