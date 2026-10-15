export function validateOrder(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Тело заявки должно быть объектом' });
  }
  const { name, email, quantity, product_id, phone, comment } = body;

  if (typeof name !== 'string' || !name.trim() ||
      typeof email !== 'string' || !email.trim() || quantity === undefined || quantity === '') {
    return res.status(400).json({ error: 'Поля name, email и quantity обязательны' });
  }

  if ((typeof quantity !== 'number' && typeof quantity !== 'string') ||
      (typeof quantity === 'string' && !quantity.trim()) ||
      !Number.isInteger(Number(quantity)) || Number(quantity) > 2147483647) {
    return res.status(400).json({ error: 'Количество должно быть целым числом в диапазоне INTEGER' });
  }
  if (Number(quantity) < 10) {
    return res.status(400).json({ error: 'Минимальный объём заказа — 10 кг' });
  }

  if (product_id !== undefined && product_id !== null && product_id !== '' &&
      ((typeof product_id !== 'number' && typeof product_id !== 'string') ||
       !/^\d+$/.test(String(product_id)) || Number(product_id) < 1 || Number(product_id) > 2147483647)) {
    return res.status(400).json({ error: 'product_id должен быть положительным целым числом' });
  }
  for (const value of [phone, comment]) {
    if (value != null && typeof value !== 'string') {
      return res.status(400).json({ error: 'Телефон и комментарий должны быть строками' });
    }
  }
  if (body.date !== undefined && body.delivery_date !== undefined && body.date !== body.delivery_date) {
    return res.status(400).json({ error: 'Поля date и delivery_date не должны противоречить друг другу' });
  }
  const date = body.date ?? body.delivery_date;
  if (date !== undefined && date !== null && date !== '') {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'Дата должна быть существующей датой в формате YYYY-MM-DD' });
    }
  }
  next();
}
