export function validateOrder(req, res, next) {
  const { name, email, quantity } = req.body || {};

  if (!name || !email || !quantity) {
    return res.status(400).json({ error: 'Поля name, email и quantity обязательны' });
  }

  if (Number(quantity) < 10) {
    return res.status(400).json({ error: 'Минимальный объём заказа — 10 кг' });
  }

  next();
}
