const baseUrl = process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
try {
  const response = await fetch(new URL('/api/health', baseUrl));
  const body = await response.json();
  if (!response.ok || body.status !== 'ok' || body.db !== 'connected' || !body.version) {
    throw new Error(`Health check failed (${response.status}).`);
  }
  console.log(`Smoke check passed: ${body.version}`);
} catch (error) {
  console.error(error.message || 'Smoke check failed.');
  process.exitCode = 1;
}
