import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const config = Object.freeze({
  release: '0.1.2-http-error-semantics-stabilization',
  nodeEnv: 'test', production: false, host: '127.0.0.1', port: 0, logLevel: 'silent', trustProxy: false,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:1/not_used',
  dbPoolMax: 2, dbConnectionTimeoutMs: 250, dbStatementTimeoutMs: 500,
  jwtAccessSecret: 'http-semantics-test-access-secret-abcdefghijklmnopqrstuvwxyz0123456789',
  jwtAccessTtlMinutes: 15, refreshTokenTtlDays: 30,
  serviceCredentialPepper: 'http-semantics-test-service-pepper-abcdefghijklmnopqrstuvwxyz0123456789',
  corsOrigins: [], bodyLimitBytes: 65536, rateLimitMax: 100, authRateLimitMax: 20,
});

const app = await buildApp(config);
try {
  const bodylessLogout = await app.inject({ method: 'POST', url: '/v1/merchant/auth/logout' });
  assert.equal(bodylessLogout.statusCode, 401);
  assert.equal(bodylessLogout.json().error.code, 'UNAUTHORIZED');

  const unsupported = await app.inject({
    method: 'POST', url: '/v1/merchant/auth/logout',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=b',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.equal(unsupported.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const invalidJson = await app.inject({
    method: 'POST', url: '/v1/merchant/auth/login',
    headers: { 'content-type': 'application/json', 'x-tenant-slug': 'demo' }, payload: '{',
  });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.json().error.code, 'INVALID_JSON');

  const missingAuth = await app.inject({ method: 'GET', url: '/v1/merchant/me' });
  assert.equal(missingAuth.statusCode, 401);
  assert.equal(missingAuth.json().error.code, 'UNAUTHORIZED');

  const missingRoute = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
  assert.equal(missingRoute.statusCode, 404);
  assert.equal(missingRoute.json().error.code, 'ROUTE_NOT_FOUND');

  console.log('PASS bodyless POST reaches auth semantics instead of media-type failure');
  console.log('PASS unsupported media type remains 415');
  console.log('PASS invalid JSON remains 400');
  console.log('PASS invalid auth remains 401');
  console.log('PASS unknown route uses structured 404');
} finally {
  await app.close();
}

const rateLimitedApp = await buildApp({ ...config, rateLimitMax: 1 });
try {
  const first = await rateLimitedApp.inject({ method: 'GET', url: '/health/live' });
  assert.equal(first.statusCode, 200);
  const second = await rateLimitedApp.inject({ method: 'GET', url: '/health/live' });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, 'RATE_LIMITED');
  console.log('PASS rate limiting remains 429');
} finally {
  await rateLimitedApp.close();
}
