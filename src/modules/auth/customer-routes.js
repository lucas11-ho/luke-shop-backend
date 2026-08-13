import { errors } from '../../core/errors.js';
import { normalizeEmail, publicId, uuid } from '../../core/identifiers.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../../core/passwords.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../core/tokens.js';
import { writeAudit } from '../../core/audit.js';

const authBody = {
  type: 'object', additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 5, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
    password: { type: 'string', minLength: 12, maxLength: 128 },
    display_name: { type: 'string', minLength: 1, maxLength: 100 },
  },
};

function publicCustomer(row) {
  return { id: row.public_id, display_name: row.display_name, email: row.email, status: row.status };
}

async function createSession(app, client, tenantId, customerId, request) {
  const refreshToken = newRefreshToken();
  const sessionId = uuid();
  await client.query(
    `INSERT INTO customer_sessions(id, tenant_id, customer_id, refresh_token_hash, expires_at, user_agent, request_ip)
     VALUES($1,$2,$3,$4,now()+($5::text || ' days')::interval,$6,$7)`,
    [sessionId, tenantId, customerId, hashRefreshToken(refreshToken), app.config.refreshTokenTtlDays,
      request.headers['user-agent'] || null, request.ip || null],
  );
  const access = await signAccessToken(app.config, {
    subject: customerId, tenantId, actorType: 'CUSTOMER', sessionId,
  });
  return { access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken };
}

export async function customerAuthRoutes(app) {
  app.post('/v1/customer/auth/register', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: authBody },
  }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    let password;
    try { password = assertPasswordPolicy(request.body.password); }
    catch (error) { throw errors.badRequest('PASSWORD_POLICY', error.message); }
    const passwordHash = await hashPassword(password);
    const customerId = uuid();
    const customerPublicId = publicId('cus');
    const displayName = request.body.display_name?.trim() || email.split('@')[0];

    const result = await app.db.transaction(async (client) => {
      const duplicate = await client.query('SELECT 1 FROM customers WHERE tenant_id = $1 AND email = $2', [request.tenant.id, email]);
      if (duplicate.rowCount) throw errors.conflict('CUSTOMER_EMAIL_EXISTS', 'An account already exists for this email');
      const inserted = await client.query(
        `INSERT INTO customers(id, public_id, tenant_id, email, password_hash, display_name, status)
         VALUES($1,$2,$3,$4,$5,$6,'ACTIVE') RETURNING *`,
        [customerId, customerPublicId, request.tenant.id, email, passwordHash, displayName],
      );
      await client.query(
        `INSERT INTO customer_status_history(tenant_id, customer_id, from_status, to_status, reason, changed_by_type)
         VALUES($1,$2,NULL,'ACTIVE','registration','CUSTOMER')`,
        [request.tenant.id, customerId],
      );
      const tokens = await createSession(app, client, request.tenant.id, customerId, request);
      await writeAudit(client, {
        tenantId: request.tenant.id, actorType: 'CUSTOMER', actorId: customerId,
        action: 'customer.register', targetType: 'customer', targetId: customerId,
        requestIp: request.ip, requestId: request.id,
      });
      return { customer: publicCustomer(inserted.rows[0]), tokens };
    });

    return reply.code(201).send({ data: result });
  });

  app.post('/v1/customer/auth/login', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: authBody },
  }, async (request) => {
    const email = normalizeEmail(request.body.email);
    const found = await app.db.query(
      `SELECT id, public_id, email, display_name, status, password_hash
         FROM customers WHERE tenant_id = $1 AND email = $2`,
      [request.tenant.id, email],
    );
    const row = found.rows[0];
    const valid = row ? await verifyPassword(row.password_hash, request.body.password) : false;
    if (!valid) throw errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    if (row.status !== 'ACTIVE') throw errors.forbidden('CUSTOMER_NOT_ACTIVE', 'Customer account is not active');

    return app.db.transaction(async (client) => {
      const tokens = await createSession(app, client, request.tenant.id, row.id, request);
      await client.query('UPDATE customers SET last_login_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2', [request.tenant.id, row.id]);
      await writeAudit(client, { tenantId: request.tenant.id, actorType: 'CUSTOMER', actorId: row.id,
        action: 'customer.login', targetType: 'customer', targetId: row.id, requestIp: request.ip, requestId: request.id });
      return { data: { customer: publicCustomer(row), tokens } };
    });
  });

  app.post('/v1/customer/auth/refresh', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['refresh_token'], properties: { refresh_token: { type: 'string', minLength: 40, maxLength: 512 } } } },
  }, async (request) => {
    const digest = hashRefreshToken(request.body.refresh_token);
    return app.db.transaction(async (client) => {
      const found = await client.query(
        `SELECT s.id AS session_id, s.customer_id, c.status
           FROM customer_sessions s
           JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1 AND s.refresh_token_hash = $2
            AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE`,
        [request.tenant.id, digest],
      );
      if (!found.rowCount || found.rows[0].status !== 'ACTIVE') {
        throw errors.unauthorized('REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
      }
      const nextRefresh = newRefreshToken();
      await client.query(
        `UPDATE customer_sessions SET refresh_token_hash = $1, last_seen_at = now()
          WHERE tenant_id = $2 AND id = $3 AND customer_id = $4`,
        [hashRefreshToken(nextRefresh), request.tenant.id, found.rows[0].session_id, found.rows[0].customer_id],
      );
      const access = await signAccessToken(app.config, {
        subject: found.rows[0].customer_id, tenantId: request.tenant.id,
        actorType: 'CUSTOMER', sessionId: found.rows[0].session_id,
      });
      await writeAudit(client, { tenantId: request.tenant.id, actorType: 'CUSTOMER', actorId: found.rows[0].customer_id,
        action: 'customer.refresh', targetType: 'customer_session', targetId: found.rows[0].session_id,
        requestIp: request.ip, requestId: request.id });
      return { data: { tokens: { access_token: access.token, expires_in: access.expiresIn, refresh_token: nextRefresh } } };
    });
  });

  app.post('/v1/customer/auth/logout', { preHandler: [app.requireCustomerAuth] }, async (request) => {
    return app.db.transaction(async (client) => {
      const revoked = await client.query(
        `UPDATE customer_sessions
            SET revoked_at = now(), last_seen_at = now()
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
          RETURNING customer_id`,
        [request.auth.tenantId, request.auth.profile.session_id],
      );
      if (!revoked.rowCount) throw errors.unauthorized('SESSION_INVALID', 'Session is no longer active');
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.profile.id,
        action: 'customer.logout', targetType: 'customer_session', targetId: request.auth.profile.session_id,
        requestIp: request.ip, requestId: request.id });
      return { data: { logged_out: true } };
    });
  });

  app.get('/v1/customer/me', { preHandler: [app.requireCustomerAuth] }, async (request) => ({
    data: { customer: publicCustomer(request.auth.profile) },
  }));
}
