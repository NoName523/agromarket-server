import { Router } from 'express';
import { validateOrder } from '../middleware/validateOrder.js';

const router = Router();
const orders = [];
let nextId = 1;

router.get('/', (req, res) => {
  res.json(orders);
});

router.post('/', validateOrder, (req, res) => {
  const { name, email, phone, quantity, date, comment } = req.body || {};

  const order = {
    id: nextId++,
    name,
    email,
    phone,
    date,
    comment,
    quantity: Number(quantity),
    createdAt: new Date().toISOString()
  };

  orders.push(order);
  res.status(201).json(order);
});

export default router;
