import { errors } from '../../core/errors.js';
import { normalizeEmail, uuid } from '../../core/identifiers.js';
import { verifyPassword } from '../../core/passwords.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../core/tokens.js';
import { writeAudit } from '../../core/audit.js';

async function loadIdentity(client, tenantId, email) {
  const user = await client.query(
    `SELECT id, public_id, email, display_name, status, password_hash
       FROM merchant_users WHERE tenant_id = $1 AND email = $2`, [tenantId, email]);
  if (!user.rowCount) return null;
  const roles = await client.query(
    `SELECT r.key FROM merchant_user_roles ur
       JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
      WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2`, [tenantId, user.rows[0].id]);
  const permissions = await client.query(
    `SELECT DISTINCT rp.permission_key FROM merchant_user_roles ur
       JOIN merchant_roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       JOIN merchant_role_permissions rp ON rp.role_id = r.id
      WHERE ur.tenant_id = $1 AND ur.merchant_user_id = $2`, [tenantId, user.rows[0].id]);
  return { ...user.rows[0], roleKeys: roles.rows.map((r) => r.key), permissions: permissions.rows.map((r) => r.permission_key) };
}

async function createSession(app, client, tenantId, user, request) {
  const sessionId = uuid();
  const refreshToken = newRefreshToken();
  await client.query(
    `INSERT INTO merchant_sessions(id, tenant_id, merchant_user_id, refresh_token_hash, expires_at, user_agent, request_ip)
     VALUES($1,$2,$3,$4,now()+($5::text || ' days')::interval,$6,$7)`,
    [sessionId, tenantId, user.id, hashRefreshToken(refreshToken), app.config.refreshTokenTtlDays,
      request.headers['user-agent'] || null, request.ip || null],
  );
  const access = await signAccessToken(app.config, {
    subject: user.id, tenantId, actorType: 'MERCHANT', sessionId,
    permissions: user.permissions, roleKeys: user.roleKeys,
  });
  return { access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken };
}

export async function merchantAuthRoutes(app) {
  app.post('/v1/merchant/auth/login', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
      email: { type: 'string', minLength: 5, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }, password: { type: 'string', minLength: 12, maxLength: 128 },
    } } },
  }, async (request) => {
    const email = normalizeEmail(request.body.email);
    return app.db.transaction(async (client) => {
      const user = await loadIdentity(client, request.tenant.id, email);
      const valid = user ? await verifyPassword(user.password_hash, request.body.password) : false;
      if (!valid) throw errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      if (user.status !== 'ACTIVE') throw errors.forbidden('MERCHANT_NOT_ACTIVE', 'Merchant account is not active');
      const tokens = await createSession(app, client, request.tenant.id, user, request);
      await client.query('UPDATE merchant_users SET last_login_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2', [request.tenant.id, user.id]);
      await writeAudit(client, { tenantId: request.tenant.id, actorType: 'MERCHANT', actorId: user.id,
        action: 'merchant.login', targetType: 'merchant_user', targetId: user.id, requestIp: request.ip, requestId: request.id });
      return { data: { user: { id: user.public_id, email: user.email, display_name: user.display_name, status: user.status,
        roles: user.roleKeys, permissions: user.permissions }, tokens } };
    });
  });

  app.post('/v1/merchant/auth/refresh', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['refresh_token'], properties: { refresh_token: { type: 'string', minLength: 40, maxLength: 512 } } } },
  }, async (request) => {
    const digest = hashRefreshToken(request.body.refresh_token);
    return app.db.transaction(async (client) => {
      const found = await client.query(
        `SELECT s.id AS session_id, s.merchant_user_id, u.email, u.status
           FROM merchant_sessions s
           JOIN merchant_users u ON u.id = s.merchant_user_id AND u.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1 AND s.refresh_token_hash = $2
            AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE`, [request.tenant.id, digest]);
      if (!found.rowCount || found.rows[0].status !== 'ACTIVE') throw errors.unauthorized('REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
      const user = await loadIdentity(client, request.tenant.id, found.rows[0].email);
      const nextRefresh = newRefreshToken();
      await client.query(
        `UPDATE merchant_sessions SET refresh_token_hash = $1, last_seen_at = now()
          WHERE tenant_id = $2 AND id = $3 AND merchant_user_id = $4`,
        [hashRefreshToken(nextRefresh), request.tenant.id, found.rows[0].session_id, found.rows[0].merchant_user_id],
      );
      const access = await signAccessToken(app.config, { subject: user.id, tenantId: request.tenant.id, actorType: 'MERCHANT',
        sessionId: found.rows[0].session_id, permissions: user.permissions, roleKeys: user.roleKeys });
      await writeAudit(client, { tenantId: request.tenant.id, actorType: 'MERCHANT', actorId: user.id,
        action: 'merchant.refresh', targetType: 'merchant_session', targetId: found.rows[0].session_id,
        requestIp: request.ip, requestId: request.id });
      return { data: { tokens: { access_token: access.token, expires_in: access.expiresIn, refresh_token: nextRefresh } } };
    });
  });

  app.post('/v1/merchant/auth/logout', { preHandler: [app.requireMerchantAuth] }, async (request) => {
    return app.db.transaction(async (client) => {
      // Revoke the session ID that the auth guard just loaded from PostgreSQL. The
      // authenticated session is already tenant/user-bound, so logout does not
      // need to trust a second copy of actor/session identifiers from the JWT.
      const revoked = await client.query(
        `UPDATE merchant_sessions
            SET revoked_at = now(), last_seen_at = now()
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
          RETURNING merchant_user_id`,
        [request.auth.tenantId, request.auth.profile.session_id],
      );
      if (!revoked.rowCount) throw errors.unauthorized('SESSION_INVALID', 'Session is no longer active');
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.profile.id,
        action: 'merchant.logout', targetType: 'merchant_session', targetId: request.auth.profile.session_id,
        requestIp: request.ip, requestId: request.id });
      return { data: { logged_out: true } };
    });
  });

  app.get('/v1/merchant/me', { preHandler: [app.requireMerchantAuth] }, async (request) => ({ data: {
    user: { id: request.auth.profile.public_id, email: request.auth.profile.email, display_name: request.auth.profile.display_name,
      status: request.auth.profile.status, roles: request.auth.roleKeys, permissions: request.auth.permissions },
  } }));
}
