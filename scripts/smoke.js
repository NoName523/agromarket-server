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
    new URL(apiUrl);
    new URL(frontendUrl);
  } catch {
    throw new Error('API_URL and FRONTEND_URL must be valid absolute URLs.');
  }
}

function endpoint(path) {
  return new URL(path, apiUrl);
}

async function waitForExpectedHealth() {
  const deadline = Date.now() + healthTimeoutMs;
  let lastVersion = 'unavailable';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint('/api/health'), {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      lastVersion = body.version || 'missing';
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
  const response = await fetch(endpoint('/api/products'));
  const products = await response.json();
  if (!response.ok || !Array.isArray(products) || products.length === 0) {
    throw new Error('Product catalog must return a non-empty array.');
  }
}

async function assertAnonymousProductCreationIsDenied() {
  const response = await fetch(endpoint('/api/products'), {
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
  const response = await fetch(endpoint('/api/products'), {
    method: 'OPTIONS',
    headers: {
      Origin: frontendOrigin,
      'Access-Control-Request-Method': 'GET',
    },
  });
  if (response.headers.get('access-control-allow-origin') !== frontendOrigin) {
    throw new Error('CORS did not allow FRONTEND_URL.');
  }
}

async function assertMissingProductReturns404() {
  const response = await fetch(endpoint('/api/products/999999'));
  if (response.status !== 404) {
    throw new Error(`Missing product returned ${response.status}, expected 404.`);
  }
}

try {
  requireConfiguration();
  await waitForExpectedHealth();
  await assertProductsAvailable();
  await assertAnonymousProductCreationIsDenied();
  await assertFrontendCors();
  await assertMissingProductReturns404();
  console.log(`Production smoke checks passed for version ${expectedVersion}.`);
} catch (error) {
  console.error(error.message || 'Production smoke checks failed.');
  process.exitCode = 1;
}
