import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../middleware/schemas.js';

const router = Router();
const integer = z.number().int().min(1).max(2147483647);
const checkout = z.object({
  address: z.string().trim().min(5).max(200),
  items: z.array(z.object({ productId: integer, quantity: integer })).min(1).max(1000),
});

router.post('/', requireAuth, requireRole('user'), validate(checkout), async (req, res, next) => {
  const quantities = new Map();
  for (const item of req.body.items) {
    const quantity = (quantities.get(item.productId) || 0) + item.quantity;
    if (quantity > 2147483647) return res.status(400).json({ error: 'Quantity is too large' });
    quantities.set(item.productId, quantity);
  }

  let client;
  let transaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transaction = true;
    const ids = [...quantities.keys()].sort((a, b) => a - b);
    const { rows: products } = await client.query(
      'SELECT id, name, stock, price FROM public.products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ids],
    );
    if (products.length !== ids.length) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(404).json({ error: 'Product not found' });
    }
    const shortage = products.find((product) => product.stock < quantities.get(product.id));
    if (shortage) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(409).json({ error: 'Insufficient stock', details: {
        productId: shortage.id, name: shortage.name, available: shortage.stock,
      } });
    }
    const total = products.reduce((sum, product) =>
      sum + BigInt(product.price) * BigInt(quantities.get(product.id)), 0n);
    if (total > 9223372036854775807n) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(400).json({ error: 'Order total is too large' });
    }
    const { rows: [order] } = await client.query(
      'INSERT INTO public.purchase_orders (user_id, address, total_price) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.body.address, total.toString()],
    );
    for (const product of products) {
      const quantity = quantities.get(product.id);
      await client.query(
        'INSERT INTO public.order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
        [order.id, product.id, quantity, product.price],
      );
      await client.query('UPDATE public.products SET stock = stock - $1 WHERE id = $2', [quantity, product.id]);
    }
    await client.query('COMMIT');
    transaction = false;
    return res.status(201).json(order);
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally {
    client?.release();
  }
});

router.get('/my', requireAuth, requireRole('user'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.id, o.status, o.address, o.total_price, o.created_at,
      COALESCE(json_agg(json_build_object('productId', i.product_id, 'name', p.name,
        'quantity', i.quantity, 'unit_price', i.unit_price) ORDER BY i.product_id)
        FILTER (WHERE i.product_id IS NOT NULL), '[]'::json) AS items
    FROM public.purchase_orders o
    LEFT JOIN public.order_items i ON i.order_id = o.id
    LEFT JOIN public.products p ON p.id = i.product_id
    WHERE o.user_id = $1
    GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC`, [req.user.id]);
  res.json(rows);
});

router.get('/incoming', requireAuth, requireRole('farmer'), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.id AS order_id, o.status, o.created_at, i.product_id,
      u.name AS buyer_name, o.address, p.name AS product_name, i.quantity, i.unit_price
    FROM public.order_items i
    JOIN public.purchase_orders o ON o.id = i.order_id
    JOIN public.products p ON p.id = i.product_id
    JOIN public.users u ON u.id = o.user_id
    WHERE p.farmer_id = $1
    ORDER BY o.created_at DESC, o.id DESC, i.product_id`, [req.user.id]);
  res.json(rows);
});

router.post('/:id/cancel', requireAuth, requireRole('user'), validate(idParam, 'params'), async (req, res, next) => {
  let client;
  let transaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transaction = true;
    const { rows: [order] } = await client.query(
      'SELECT id, status FROM public.purchase_orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [Number(req.params.id), req.user.id],
    );
    if (!order || order.status !== 'new') {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(order ? 409 : 404).json({ error: order ? 'Order cannot be cancelled' : 'Order not found' });
    }
    await client.query(`
      SELECT p.id FROM public.products p JOIN public.order_items i ON i.product_id = p.id
      WHERE i.order_id = $1 ORDER BY p.id FOR UPDATE OF p`, [order.id]);
    await client.query(`
      UPDATE public.products p SET stock = p.stock + i.quantity
      FROM public.order_items i WHERE i.order_id = $1 AND i.product_id = p.id`, [order.id]);
    const { rows: [updated] } = await client.query(
      "UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = $1 RETURNING *", [order.id]);
    await client.query('COMMIT');
    transaction = false;
    return res.json(updated);
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally {
    client?.release();
  }
});

export default router;
