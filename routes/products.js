import { Router } from 'express';
import { products } from '../data/products.js';

const router = Router();

router.get('/', (req, res) => {
  const { search } = req.query;
  const maxPrice = req.query.maxPrice;
  const sort = req.query.sort;

  let result = products;

  if (search !== undefined) {
    result = result.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  }

  if (maxPrice !== undefined) {
    result = result.filter((product) => Number(product.price) <= Number(maxPrice));
  }

  if (sort === 'price' || sort === '-price') {
    result = [...result];
    result.sort((a, b) => sort === 'price'
      ? Number(a.price) - Number(b.price)
      : Number(b.price) - Number(a.price));
  }

  res.json(result);
});

router.get('/:id', (req, res) => {
  const product = products.find((p) => String(p.id) === req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Товар не найден' });
  }

  res.json(product);
});

export default router;
