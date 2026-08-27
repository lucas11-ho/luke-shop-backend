import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const importPreflight = "import('./src/production-env-preflight.js')";

function run(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', importPreflight], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://admin.example.com,https://shop.example.com',
      STOREFRONT_HOST_SUFFIX: 'shops.example.com',
      ...overrides,
    },
  });
}

let result = run();
assert.equal(result.status, 0, result.stderr || result.stdout);

result = run({ CORS_ORIGINS: '*' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /cannot contain a wildcard/i);

result = run({ CORS_ORIGINS: 'http://localhost:4173' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /must use HTTPS|local hostname/i);

result = run({ CORS_ORIGINS: 'https://admin.example.com/path' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /origins only/i);

result = run({ STOREFRONT_HOST_SUFFIX: 'https://shops.example.com' });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /bare DNS hostname suffix/i);

result = run({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:4173', STOREFRONT_HOST_SUFFIX: 'localhost' });
assert.equal(result.status, 0, result.stderr || result.stdout);

console.log('PASS production environment preflight tests (6 cases)');
