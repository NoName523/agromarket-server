import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function validId(value) {
  return /^\d+$/.test(value) && Number.isInteger(Number(value)) &&
    Number(value) > 0 && Number(value) <= 2147483647;
}

function validateProduct(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Тело запроса должно быть объектом';
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return 'Поле name должно быть непустой строкой';
  }
  const { price } = body;
  if ((typeof price !== 'number' && typeof price !== 'string') ||
      (typeof price === 'string' && !price.trim()) ||
      !Number.isInteger(Number(price)) || Number(price) < 0 || Number(price) > 2147483647) {
    return 'Поле price должно быть целым числом от 0 до 2147483647';
  }
  for (const field of ['category', 'image']) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
      return `Поле ${field} должно быть строкой или null`;
    }
  }
  if (body.unit !== undefined && (typeof body.unit !== 'string' || !body.unit.trim())) {
    return 'Поле unit должно быть непустой строкой';
  }
  return null;
}

function productValues(body) {
  return [body.name.trim(), body.category ?? null, Number(body.price),
    body.unit === undefined ? 'кг' : body.unit.trim(), body.image ?? null];
}

router.get('/', async (req, res) => {
  const {
    search = '',
    maxPrice,
    sort = '',
    limit = '20',
    offset = '0',
  } = req.query;
  if (typeof search !== 'string' || typeof sort !== 'string' ||
      (maxPrice !== undefined && typeof maxPrice !== 'string') ||
      typeof limit !== 'string' || typeof offset !== 'string') {
    return res.status(400).json({
      error: 'Параметры search, maxPrice, sort, limit и offset должны быть строками',
    });
  }

  const pageSize = Number(limit);
  if (!/^\d+$/.test(limit) || !Number.isSafeInteger(pageSize) ||
      pageSize < 1 || pageSize > 100) {
    return res.status(400).json({ error: 'limit должен быть целым числом от 1 до 100' });
  }

  if (!/^\d+$/.test(offset)) {
    return res.status(400).json({ error: 'offset должен быть неотрицательным целым числом' });
  }
  const pageOffset = BigInt(offset);
  if (pageOffset > 9223372036854775807n) {
    return res.status(400).json({ error: 'offset не должен превышать максимальное значение BIGINT' });
  }

  let priceLimit = null;
  if (maxPrice !== undefined) {
    priceLimit = Number(maxPrice);
    if (!maxPrice.trim() || !Number.isFinite(priceLimit)) {
      return res.status(400).json({ error: 'maxPrice должен быть конечным числом' });
    }
  }

  const allowedSorts = new Map([
    ['price', 'price ASC, id ASC'],
    ['-price', 'price DESC, id ASC'],
    ['name', 'name ASC, id ASC'],
    ['-name', 'name DESC, id ASC'],
  ]);
  const orderBy = allowedSorts.get(sort) ?? 'id ASC';

  // Сохраняем поиск буквальной подстроки из ЛР5: %, _ и \ не являются шаблоном.
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await pool.query(
    `SELECT * FROM public.products
     WHERE name ILIKE $1
       AND ($2::numeric IS NULL OR price <= $2::numeric)
     ORDER BY ${orderBy}
     LIMIT $3 OFFSET $4`,
    [pattern, priceLimit, pageSize, pageOffset.toString()],
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: 'ID должен быть положительным целым числом в диапазоне INTEGER' });
  }

  const { rows } = await pool.query('SELECT * FROM public.products WHERE id = $1', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Товар не найден' });
  }
  res.json(rows[0]);
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const error = validateProduct(req.body);
  if (error) return res.status(400).json({ error });

  const { rows } = await pool.query(
    `INSERT INTO public.products (name, category, price, unit, image)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    productValues(req.body),
  );
  res.status(201).json(rows[0]);
});

router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: 'ID должен быть положительным целым числом в диапазоне INTEGER' });
  }
  const error = validateProduct(req.body);
  if (error) return res.status(400).json({ error });

  const { rows } = await pool.query(
    `UPDATE public.products
     SET name = $1, category = $2, price = $3, unit = $4, image = $5
     WHERE id = $6 RETURNING *`,
    [...productValues(req.body), Number(req.params.id)],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Товар не найден' });
  res.json(rows[0]);
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: 'ID должен быть положительным целым числом в диапазоне INTEGER' });
  }
  const { rowCount } = await pool.query(
    'DELETE FROM public.products WHERE id = $1', [Number(req.params.id)],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Товар не найден' });
  res.status(204).end();
});

export default router;
