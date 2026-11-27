import { z } from 'zod';

const utf8Encoder = new TextEncoder();

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const passwordSchema = z.string().min(8, 'Password must contain at least 8 characters')
  .max(72, 'Password must contain at most 72 characters')
  .refine((value) => utf8Encoder.encode(value).length <= 72,
    'Password must not exceed 72 bytes');

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(1024, 'Password is too long'),
});

const MAX_POSTGRES_INTEGER = '2147483647';
const priceSchema = z.union([
  z.number(),
  z.string().trim()
    .regex(/^\d+$/, 'Price must be a positive whole number')
    .refine((value) => {
      const canonical = value.replace(/^0+(?=\d)/, '');
      return canonical.length < MAX_POSTGRES_INTEGER.length ||
        (canonical.length === MAX_POSTGRES_INTEGER.length && canonical <= MAX_POSTGRES_INTEGER);
    }, 'Price is too large')
    .transform(Number),
]).pipe(
  z.number().int('Price must be a whole number').positive('Price must be greater than zero')
    .max(2147483647, 'Price is too large'),
);

const productFields = {
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  category: z.string().trim().max(100, 'Category is too long').nullable().optional(),
  price: priceSchema,
  stock: z.union([
    z.number(),
    z.string().trim().regex(/^\d+$/, 'Stock must be a non-negative whole number').transform(Number),
  ]).pipe(z.number().int().min(0).max(2147483647)).optional(),
  unit: z.string().trim().min(1, 'Unit is required').max(32, 'Unit is too long').optional(),
  image: z.string().trim().max(2048, 'Image URL is too long').nullable().optional(),
};

export const productSchema = z.object(productFields);
export const productUpdateSchema = z.object(productFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one product field is required');

export const idParam = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be a positive integer')
    .refine((value) => Number.isSafeInteger(Number(value)) &&
      Number(value) > 0 && Number(value) <= 2147483647,
    'ID must be a positive integer within the supported range'),
});

export const orderStatusSchema = z.object({
  status: z.string().trim().min(1, 'Status is required')
    .refine((value) => ['new', 'processing', 'done', 'cancelled'].includes(value),
      'Status is not supported'),
});
