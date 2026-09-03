import { errors } from '../core/errors.js';
import { verifyAccessToken } from '../core/tokens.js';
import { enforceMerchantStoreScope } from '../modules/merchant/store-access.js';

function bearer(request) {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ')) throw errors.unauthorized();
  return value.slice(7).trim();
}

export function authPlugin(app) {
  app.decorateRequest('auth', null);

  app.decorate('requireCustomerAuth', async function requireCustomerAuth(request) {
    const token = bearer(request);
    let payload;
    try {
      payload = await verifyAccessToken(app.config, token);
    } catch {
      throw errors.unauthorized('ACCESS_TOKEN_INVALID', 'Invalid or expired access token');
    }
    if (payload.actor_type !== 'CUSTOMER') throw errors.forbidden('ACTOR_TYPE_INVALID', 'Customer authentication required');
    const result = await app.db.query(
      `SELECT c.id, c.public_id, c.customer_code, c.status, c.display_name, c.email, c.phone_e164, c.avatar_url, c.birth_date::text AS birth_date, s.id AS session_id
         FROM customer_sessions s
         JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2 AND c.id = $3
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND c.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
      [payload.session_id, payload.tenant_id, payload.sub],
    );
    if (!result.rowCount) throw errors.unauthorized('SESSION_INVALID', 'Session is no longer active');
    request.auth = {
      actorType: 'CUSTOMER', tenantId: payload.tenant_id, actorId: result.rows[0].id,
      sessionId: result.rows[0].session_id, permissions: [], roleKeys: [], profile: result.rows[0],
    };
  });

  app.decorate('requireMerchantAuth', async function requireMerchantAuth(request) {
    const token = bearer(request);
    let payload;
    try {
      payload = await verifyAccessToken(app.config, token);
    } catch {
      throw errors.unauthorized('ACCESS_TOKEN_INVALID', 'Invalid or expired access token');
    }
    if (payload.actor_type !== 'MERCHANT') throw errors.forbidden('ACTOR_TYPE_INVALID', 'Merchant authentication required');
    const result = await app.db.query(
      `SELECT u.id, u.public_id, u.status, u.display_name, u.email, u.store_access_mode, s.id AS session_id
         FROM merchant_sessions s
         JOIN merchant_users u ON u.id = s.merchant_user_id AND u.tenant_id = s.tenant_id
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2 AND u.id = $3
          AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status = 'ACTIVE' AND t.status = 'ACTIVE'`,
      [payload.session_id, payload.tenant_id, payload.sub],
    );
    if (!result.rowCount) throw errors.unauthorized('SESSION_INVALID', 'Session is no longer active');
    const permissions = await app.db.query(
      `SELECT DISTINCT rp.permission_key
         FROM merchant_user_roles ur
         JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
         JOIN merchant_role_permissions rp ON rp.role_id = r.id
        WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2`,
      [payload.tenant_id, payload.sub],
    );
    const roles = await app.db.query(
      `SELECT r.key
         FROM merchant_user_roles ur
         JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
        WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2`,
      [payload.tenant_id, payload.sub],
    );
    request.auth = {
      actorType: 'MERCHANT', tenantId: payload.tenant_id, actorId: result.rows[0].id,
      sessionId: result.rows[0].session_id,
      permissions: permissions.rows.map((row) => row.permission_key),
      roleKeys: roles.rows.map((row) => row.key),
      profile: result.rows[0],
    };
    // Store authorization is deliberately re-read from PostgreSQL on every
    // authenticated request. JWT/browser store state is never authoritative.
    await enforceMerchantStoreScope(app.db, request, request.auth);
  });

  app.decorate('requirePermission', function requirePermission(permission) {
    return async function permissionGuard(request) {
      if (!request.auth?.permissions?.includes(permission)) {
        throw errors.forbidden('PERMISSION_REQUIRED', `Missing permission: ${permission}`);
      }
    };
  });
}
