import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';

const config = loadConfig();
const app = await buildApp(config);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const slug = `auth-${suffix}`;
const merchantEmail = `owner-${suffix}@example.com`;
const customerEmail = `customer-${suffix}@example.com`;
const password = 'Auth-Lifecycle-Password-2026!';
let tenantId;

function json(response) {
  try { return response.json(); } catch { return null; }
}

function expectStatus(response, status, label) {
  assert.equal(response.statusCode, status, `${label}: ${response.statusCode} ${response.body}`);
  return json(response);
}

async function request(options) {
  return app.inject(options);
}

try {
  await app.ready();
  const db = app.db;
  const passwordHash = await hashPassword(password);
  tenantId = randomUUID();
  const merchantId = randomUUID();
  const roleId = randomUUID();

  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO tenants(id, public_id, slug, name, status)
       VALUES($1,$2,$3,$4,'ACTIVE')`,
      [tenantId, `tnt_auth_${suffix}`, slug, `Auth Test ${suffix}`],
    );
    await client.query('INSERT INTO tenant_settings(tenant_id) VALUES($1)', [tenantId]);
    await client.query(
      `INSERT INTO merchant_users(id, public_id, tenant_id, email, password_hash, display_name, status)
       VALUES($1,$2,$3,$4,$5,'Auth Owner','ACTIVE')`,
      [merchantId, `musr_auth_${suffix}`, tenantId, merchantEmail, passwordHash],
    );
    await client.query(
      `INSERT INTO merchant_roles(id, tenant_id, key, name, is_system)
       VALUES($1,$2,'OWNER','Owner',true)`,
      [roleId, tenantId],
    );
    for (const permission of ALL_PERMISSIONS) {
      await client.query('INSERT INTO merchant_role_permissions(role_id, permission_key) VALUES($1,$2)', [roleId, permission]);
    }
    await client.query(
      'INSERT INTO merchant_user_roles(tenant_id, merchant_user_id, role_id) VALUES($1,$2,$3)',
      [tenantId, merchantId, roleId],
    );
  });

  const tenantHeaders = { 'x-tenant-slug': slug };

  // Merchant: login -> protected read -> refresh rotation -> logout -> both credentials rejected.
  const merchantLogin = expectStatus(await request({
    method: 'POST', url: '/v1/merchant/auth/login', headers: tenantHeaders,
    payload: { email: merchantEmail, password },
  }), 200, 'merchant login');
  const merchantAccess1 = merchantLogin.data.tokens.access_token;
  const merchantRefresh1 = merchantLogin.data.tokens.refresh_token;
  expectStatus(await request({ method: 'GET', url: '/v1/merchant/me', headers: { authorization: `Bearer ${merchantAccess1}` } }), 200, 'merchant me');

  const merchantRefreshResponse = expectStatus(await request({
    method: 'POST', url: '/v1/merchant/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: merchantRefresh1 },
  }), 200, 'merchant refresh');
  const merchantAccess2 = merchantRefreshResponse.data.tokens.access_token;
  const merchantRefresh2 = merchantRefreshResponse.data.tokens.refresh_token;
  const merchantReplay = expectStatus(await request({
    method: 'POST', url: '/v1/merchant/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: merchantRefresh1 },
  }), 401, 'merchant old refresh replay');
  assert.equal(merchantReplay.error.code, 'REFRESH_TOKEN_INVALID');

  const merchantLogout = expectStatus(await request({
    method: 'POST', url: '/v1/merchant/auth/logout',
    headers: { authorization: `Bearer ${merchantAccess2}` },
  }), 200, 'merchant logout');
  assert.equal(merchantLogout.data.logged_out, true);
  const merchantAfterLogout = expectStatus(await request({
    method: 'GET', url: '/v1/merchant/me', headers: { authorization: `Bearer ${merchantAccess2}` },
  }), 401, 'merchant access after logout');
  assert.equal(merchantAfterLogout.error.code, 'SESSION_INVALID');
  const merchantRefreshAfterLogout = expectStatus(await request({
    method: 'POST', url: '/v1/merchant/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: merchantRefresh2 },
  }), 401, 'merchant refresh after logout');
  assert.equal(merchantRefreshAfterLogout.error.code, 'REFRESH_TOKEN_INVALID');

  // Customer: register creates a session; exercise the same refresh/logout lifecycle.
  const customerRegister = expectStatus(await request({
    method: 'POST', url: '/v1/customer/auth/register', headers: tenantHeaders,
    payload: { email: customerEmail, password, display_name: 'Auth Customer' },
  }), 201, 'customer register');
  const customerAccess1 = customerRegister.data.tokens.access_token;
  const customerRefresh1 = customerRegister.data.tokens.refresh_token;
  expectStatus(await request({ method: 'GET', url: '/v1/customer/me', headers: { authorization: `Bearer ${customerAccess1}` } }), 200, 'customer me');

  const customerRefreshResponse = expectStatus(await request({
    method: 'POST', url: '/v1/customer/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: customerRefresh1 },
  }), 200, 'customer refresh');
  const customerAccess2 = customerRefreshResponse.data.tokens.access_token;
  const customerRefresh2 = customerRefreshResponse.data.tokens.refresh_token;
  const customerReplay = expectStatus(await request({
    method: 'POST', url: '/v1/customer/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: customerRefresh1 },
  }), 401, 'customer old refresh replay');
  assert.equal(customerReplay.error.code, 'REFRESH_TOKEN_INVALID');

  const customerLogout = expectStatus(await request({
    method: 'POST', url: '/v1/customer/auth/logout',
    headers: { authorization: `Bearer ${customerAccess2}` },
  }), 200, 'customer logout');
  assert.equal(customerLogout.data.logged_out, true);
  const customerAfterLogout = expectStatus(await request({
    method: 'GET', url: '/v1/customer/me', headers: { authorization: `Bearer ${customerAccess2}` },
  }), 401, 'customer access after logout');
  assert.equal(customerAfterLogout.error.code, 'SESSION_INVALID');
  const customerRefreshAfterLogout = expectStatus(await request({
    method: 'POST', url: '/v1/customer/auth/refresh', headers: tenantHeaders,
    payload: { refresh_token: customerRefresh2 },
  }), 401, 'customer refresh after logout');
  assert.equal(customerRefreshAfterLogout.error.code, 'REFRESH_TOKEN_INVALID');

  const audits = await db.query(
    `SELECT action FROM audit_logs WHERE tenant_id = $1
       AND action IN ('merchant.refresh','merchant.logout','customer.refresh','customer.logout')`,
    [tenantId],
  );
  const actions = new Set(audits.rows.map((row) => row.action));
  for (const action of ['merchant.refresh','merchant.logout','customer.refresh','customer.logout']) {
    assert.ok(actions.has(action), `missing audit action ${action}`);
  }

  console.log('PASS live PostgreSQL merchant/customer login-refresh-logout lifecycle');
  console.log('PASS old rotated refresh tokens are rejected');
  console.log('PASS revoked access and refresh credentials are rejected');
  console.log('PASS refresh/logout audit events are durable');
} finally {
  if (tenantId) {
    await app.db.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => {});
  }
  await app.close().catch(() => {});
}
