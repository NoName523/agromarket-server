import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  registerSchema, loginSchema, productSchema, productUpdateSchema,
  idParam, orderStatusSchema,
} from '../index.js';

const registration = {
  name: 'Buyer', email: 'buyer@example.com', password: 'password123',
};

test('registration normalizes email and trims name', () => {
  const parsed = registerSchema.parse({ ...registration, name: ' Buyer ',
    email: ' Buyer@Example.COM ' });
  assert.equal(parsed.email, 'buyer@example.com');
  assert.equal(parsed.name, 'Buyer');
});

test('invalid email is rejected by registration and login', () => {
  assert.equal(registerSchema.safeParse({ ...registration, email: 'invalid' }).success, false);
  assert.equal(loginSchema.safeParse({ email: 'invalid', password: 'password' }).success, false);
});

test('seven-character registration password is rejected', () => {
  assert.equal(registerSchema.safeParse({ ...registration, password: '1234567' }).success, false);
});

for (const [label, password, expectedBytes, accepted] of [
  ['ASCII boundary', 'a'.repeat(72), 72, true],
  ['ASCII overflow', 'a'.repeat(73), 73, false],
  ['Cyrillic boundary', 'я'.repeat(36), 72, true],
  ['Cyrillic overflow', 'я'.repeat(37), 74, false],
  ['emoji boundary', '😀'.repeat(18), 72, true],
  ['emoji overflow', '😀'.repeat(19), 76, false],
  ['mixed boundary', 'я'.repeat(16) + '😀'.repeat(10), 72, true],
]) {
  test(`UTF-8 password: ${label}`, () => {
    assert.equal(new TextEncoder().encode(password).length, expectedBytes);
    assert.equal(registerSchema.safeParse({ ...registration, password }).success, accepted);
  });
}

test('login preserves current password limits and normalizes email', () => {
  assert.equal(loginSchema.parse({ email: ' Buyer@Example.COM ', password: 'a' }).email,
    'buyer@example.com');
  assert.equal(loginSchema.safeParse({ email: registration.email, password: '' }).success, false);
  assert.equal(loginSchema.safeParse({ email: registration.email, password: 'a'.repeat(1024) }).success, true);
  assert.equal(loginSchema.safeParse({ email: registration.email, password: 'a'.repeat(1025) }).success, false);
});

for (const price of [100, '100', 2147483647, '2147483647']) {
  test(`accepts integer price ${JSON.stringify(price)}`, () => {
    assert.equal(productSchema.parse({ name: 'Honey', price }).price, Number(price));
  });
}

for (const price of [-100, 0, 1.5, '1.5', '1.00000000000000001', '1e3', '0x10',
  2147483648, '2147483648', '', ' ', null, true]) {
  test(`rejects price ${JSON.stringify(price)}`, () => {
    assert.equal(productSchema.safeParse({ name: 'Honey', price }).success, false);
    assert.equal(productUpdateSchema.safeParse({ price }).success, false);
  });
}

test('unknown role is stripped from registration and product data', () => {
  assert.equal(Object.hasOwn(registerSchema.parse({ ...registration, role: 'admin' }), 'role'), false);
  assert.deepEqual(productSchema.parse({ name: 'Honey', price: 100, role: 'admin' }),
    { name: 'Honey', price: 100 });
});

test('PATCH rejects empty and unknown-only bodies and accepts partial fields', () => {
  assert.equal(productUpdateSchema.safeParse({}).success, false);
  assert.equal(productUpdateSchema.safeParse({ role: 'admin' }).success, false);
  assert.deepEqual(productUpdateSchema.parse({ name: ' Honey ', role: 'admin' }), { name: 'Honey' });
});

test('stock accepts optional PostgreSQL non-negative integers and strips client ownership', () => {
  const product = { name: 'Honey', price: 100 };
  for (const stock of [0, '0', ' 7 ', 2147483647, '2147483647']) {
    assert.deepEqual(productSchema.parse({ ...product, stock, farmer_id: 999 }),
      { ...product, stock: Number(stock) });
  }
  for (const stock of [-1, 1.5, '1.5', '1e3', '0x10', '', ' ', true, null, 2147483648, '2147483648']) {
    assert.equal(productSchema.safeParse({ ...product, stock }).success, false);
    assert.equal(productUpdateSchema.safeParse({ stock }).success, false);
  }
  assert.deepEqual(productUpdateSchema.parse({ stock: 0, farmer_id: 999 }), { stock: 0 });
  assert.equal(productUpdateSchema.safeParse({ farmer_id: 999 }).success, false);
});

test('product field limits and optional nullable fields are preserved', () => {
  const valid = { name: 'Honey', price: 100, category: null, image: null, unit: 'kg' };
  assert.deepEqual(productSchema.parse(valid), valid);
  for (const [field, value] of [['name', 'a'.repeat(201)], ['category', 'a'.repeat(101)],
    ['unit', 'a'.repeat(33)], ['image', 'a'.repeat(2049)], ['unit', ' ']]) {
    assert.equal(productSchema.safeParse({ ...valid, [field]: value }).success, false);
  }
});

test('ID accepts supported positive integers and rejects malformed and out-of-range values', () => {
  assert.deepEqual(idParam.parse({ id: '2147483647' }), { id: '2147483647' });
  for (const id of ['invalid', '0', '-1', '1.5', '1e3', '2147483648', 1]) {
    assert.equal(idParam.safeParse({ id }).success, false);
  }
});

test('order status accepts known values and rejects invalid or missing values', () => {
  for (const status of ['new', 'processing', 'done', 'cancelled']) {
    assert.deepEqual(orderStatusSchema.parse({ status }), { status });
  }
  assert.equal(orderStatusSchema.safeParse({ status: 'unknown' }).success, false);
  assert.equal(orderStatusSchema.safeParse({}).success, false);
});
