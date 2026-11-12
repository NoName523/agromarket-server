import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runSmoke(failCatalog = false) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    process.env.API_URL = 'https://smoke.invalid/api/';
    process.env.FRONTEND_URL = 'https://frontend.invalid';
    process.env.EXPECTED_VERSION = 'abcdef123456';
    let healthCalls = 0;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(url.origin, 'https://smoke.invalid');
      assert.ok(options.signal);
      const path = url.pathname;
      calls.push(path);
      if (path === '/api/health') {
        healthCalls++;
        return Response.json({status:'ok', db:'connected', version:healthCalls === 1 ? 'old-sha' : 'abcdef1'});
      }
      assert.equal(healthCalls, 2, 'checks must wait for the expected version');
      if (options.method === 'POST') {
        assert.equal(path, '/api/products');
        assert.deepEqual(JSON.parse(options.body), {});
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({}, {status:401});
      }
      if (options.headers?.Origin) {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Origin, process.env.FRONTEND_URL);
        return Response.json([{}], {headers:{'Access-Control-Allow-Origin':process.env.FRONTEND_URL}});
      }
      if (path === '/api/products') return Response.json(${failCatalog ? '[]' : '[{id:1}]'});
      if (path === '/api/products/999999') return Response.json({}, {status:404});
      if (path === '/api/categories') return Response.json([{name:'Honey',count:1}]);
      throw new Error('Unexpected request');
    };
    await import('./scripts/smoke.js');
    assert.ok(calls.includes('/api/categories'), 'remaining checks must run after a failure');
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000 });
}

test('smoke waits for SHA and checks real API paths without network or database', () => {
  const result = runSmoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/PASS /g) || []).length, 6);
});

test('smoke reports an individual failure, continues checks and exits nonzero', () => {
  const result = runSmoke(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FAIL non-empty catalog/);
  assert.match(result.stdout, /PASS categories and counts/);
});
