import { setTimeout as delay } from 'node:timers/promises';

const apiUrl = process.env.API_URL;
const frontendUrl = process.env.FRONTEND_URL;
const expectedVersion = process.env.EXPECTED_VERSION?.trim().slice(0, 7);
const healthTimeoutMs = 10 * 60 * 1000;

function requireConfiguration() {
  if (!apiUrl || !frontendUrl || !expectedVersion) {
    throw new Error('API_URL, FRONTEND_URL, and EXPECTED_VERSION are required.');
  }
  try {
    const api = new URL(apiUrl);
    const frontend = new URL(frontendUrl);
    if (![api, frontend].every((url) => ['http:', 'https:'].includes(url.protocol) &&
        !url.username && !url.password && !url.search && !url.hash) ||
        !api.pathname.replace(/\/+$/, '').endsWith('/api') ||
        frontendUrl !== frontend.origin) throw new Error();
  } catch {
    throw new Error('API_URL must end in /api; FRONTEND_URL must be an exact HTTP(S) origin without trailing slash.');
  }
}

function endpoint(path) {
  return new URL(path, `${apiUrl.replace(/\/+$/, '')}/`);
}

function request(path, options = {}) {
  return fetch(endpoint(path), { ...options, signal: AbortSignal.timeout(20_000) });
}

async function waitForExpectedHealth() {
  const deadline = Date.now() + healthTimeoutMs;
  let lastVersion = 'unavailable';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint('health'), {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      lastVersion = body.version || 'missing';
      console.log(`Health: HTTP ${response.status}, version ${lastVersion}`);
      if (response.ok && body.status === 'ok' && body.db === 'connected' &&
          body.version === expectedVersion) {
        return;
      }
    } catch {
      // Render may still be building or starting the new instance.
    }
    await delay(5_000);
  }

  throw new Error(`Health did not report expected version ${expectedVersion}; last version: ${lastVersion}.`);
}

async function assertProductsAvailable() {
  const response = await request('products');
  const products = await response.json();
  if (response.status !== 200 || !Array.isArray(products) || products.length === 0) {
    throw new Error('Product catalog must return a non-empty array.');
  }
}

async function assertAnonymousProductCreationIsDenied() {
  const response = await request('products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Invalid payload prevents inserts even if auth middleware is accidentally removed.
    body: JSON.stringify({}),
  });
  if (response.status !== 401) {
    throw new Error(`Anonymous product creation returned ${response.status}, expected 401.`);
  }
}

async function assertFrontendCors() {
  const frontendOrigin = new URL(frontendUrl).origin;
  const response = await request('products', {
    method: 'GET',
    headers: {
      Origin: frontendOrigin,
    },
  });
  if (response.status !== 200 ||
      response.headers.get('access-control-allow-origin') !== frontendOrigin) {
    throw new Error('CORS did not allow FRONTEND_URL.');
  }
}

async function assertMissingProductReturns404() {
  const response = await request('products/999999');
  if (response.status !== 404) {
    throw new Error(`Missing product returned ${response.status}, expected 404.`);
  }
}

async function assertCategoriesAvailable() {
  const response = await request('categories');
  const categories = await response.json();
  if (response.status !== 200 || !Array.isArray(categories) || categories.length === 0 ||
      !categories.every((category) => category &&
        (category.name === null || typeof category.name === 'string') &&
        Number.isInteger(category.count) && category.count > 0)) {
    throw new Error('Categories must return a non-empty array with integer counts.');
  }
}

try {
  requireConfiguration();
  await waitForExpectedHealth();
  console.log(`PASS expected version ${expectedVersion}`);
  let failed = 0;
  for (const [name, check] of [
    ['non-empty catalog', assertProductsAvailable],
    ['POST without JWT returns 401', assertAnonymousProductCreationIsDenied],
    ['GET allows FRONTEND_URL via CORS', assertFrontendCors],
    ['missing product returns 404', assertMissingProductReturns404],
    ['categories and counts', assertCategoriesAvailable],
  ]) {
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  if (failed) throw new Error(`Smoke checks failed: ${failed}.`);
  console.log(`Smoke checks passed for version ${expectedVersion}.`);
} catch (error) {
  console.error(error.message || 'Production smoke checks failed.');
  process.exitCode = 1;
}
