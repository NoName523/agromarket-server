import { readFileSync } from 'node:fs';

const db = JSON.parse(readFileSync(new URL('./db.json', import.meta.url), 'utf8'));

export const products = db.products;
