import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT category AS name, COUNT(*)::int AS count
         FROM public.products
        GROUP BY category
        ORDER BY category`,
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

export default router;
