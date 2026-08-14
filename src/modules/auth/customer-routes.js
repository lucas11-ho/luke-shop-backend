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

  app.patch('/v1/customer/me', {
    preHandler: [app.requireCustomerAuth],
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      display_name: { type: 'string', minLength: 1, maxLength: 100 },
    } } },
  }, async (request) => app.db.transaction(async (client) => {
    const updated = await client.query(
      `UPDATE customers SET display_name=$1,updated_at=now()
        WHERE tenant_id=$2 AND id=$3 RETURNING public_id,email,display_name,status`,
      [request.body.display_name.trim(), request.auth.tenantId, request.auth.actorId],
    );
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.profile.update', targetType: 'customer', targetId: request.auth.actorId,
      metadata: { changed_fields: ['display_name'] }, requestIp: request.ip, requestId: request.id });
    return { data: { customer: publicCustomer(updated.rows[0]) } };
  }));

  app.post('/v1/customer/me/change-password', {
    preHandler: [app.requireCustomerAuth],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['current_password','new_password'], properties: {
      current_password: { type: 'string', minLength: 12, maxLength: 128 },
      new_password: { type: 'string', minLength: 12, maxLength: 128 },
    } } },
  }, async (request) => app.db.transaction(async (client) => {
    const found = await client.query('SELECT password_hash FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [request.auth.tenantId, request.auth.actorId]);
    if (!found.rowCount || !await verifyPassword(found.rows[0].password_hash, request.body.current_password)) {
      throw errors.unauthorized('CURRENT_PASSWORD_INVALID', 'Current password is incorrect');
    }
    let next;
    try { next = assertPasswordPolicy(request.body.new_password); }
    catch (error) { throw errors.badRequest('PASSWORD_POLICY', error.message); }
    const hash = await hashPassword(next);
    await client.query('UPDATE customers SET password_hash=$1,password_changed_at=now(),updated_at=now() WHERE tenant_id=$2 AND id=$3', [hash, request.auth.tenantId, request.auth.actorId]);
    const revoked = await client.query('UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND customer_id=$2 AND id<>$3 AND revoked_at IS NULL', [request.auth.tenantId, request.auth.actorId, request.auth.sessionId]);
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.password.change', targetType: 'customer', targetId: request.auth.actorId,
      metadata: { other_sessions_revoked: revoked.rowCount }, requestIp: request.ip, requestId: request.id });
    return { data: { changed: true, other_sessions_revoked: revoked.rowCount } };
  }));

  app.get('/v1/customer/me/addresses', { preHandler: [app.requireCustomerAuth] }, async (request) => {
    const rows = await app.db.query(
      `SELECT public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,is_default,created_at,updated_at
         FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2 ORDER BY is_default DESC,updated_at DESC`,
      [request.auth.tenantId, request.auth.actorId],
    );
    return { data: { addresses: rows.rows } };
  });

  app.post('/v1/customer/me/addresses', {
    preHandler: [app.requireCustomerAuth],
    schema: { body: { type: 'object', additionalProperties: false, required: ['label','recipient_name','country_code','city','address_line_1'], properties: {
      label: { type: 'string', minLength: 1, maxLength: 80 }, recipient_name: { type: 'string', minLength: 1, maxLength: 160 },
      phone: { type: ['string','null'], maxLength: 60 }, country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
      state: { type: ['string','null'], maxLength: 160 }, city: { type: 'string', minLength: 1, maxLength: 160 },
      postal_code: { type: ['string','null'], maxLength: 40 }, address_line_1: { type: 'string', minLength: 1, maxLength: 300 },
      address_line_2: { type: ['string','null'], maxLength: 300 }, delivery_note: { type: ['string','null'], maxLength: 1000 },
      is_default: { type: 'boolean' },
    } } },
  }, async (request, reply) => {
    const address = await app.db.transaction(async (client) => {
      const count = await client.query('SELECT count(*)::int AS total FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2', [request.auth.tenantId, request.auth.actorId]);
      const makeDefault = Boolean(request.body.is_default) || Number(count.rows[0]?.total || 0) === 0;
      if (makeDefault) await client.query('UPDATE customer_addresses SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2', [request.auth.tenantId, request.auth.actorId]);
      const id = uuid(); const pid = publicId('addr');
      const row = await client.query(
        `INSERT INTO customer_addresses(id,public_id,tenant_id,customer_id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,is_default)
         VALUES($1,$2,$3,$4,$5,$6,$7,upper($8),$9,$10,$11,$12,$13,$14,$15)
         RETURNING public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,is_default,created_at,updated_at`,
        [id,pid,request.auth.tenantId,request.auth.actorId,request.body.label.trim(),request.body.recipient_name.trim(),request.body.phone||null,request.body.country_code,
          request.body.state||null,request.body.city.trim(),request.body.postal_code||null,request.body.address_line_1.trim(),request.body.address_line_2||null,request.body.delivery_note||null,makeDefault],
      );
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
        action: 'customer.address.create', targetType: 'customer_address', targetId: id,
        metadata: { public_id: pid, is_default: makeDefault }, requestIp: request.ip, requestId: request.id });
      return row.rows[0];
    });
    return reply.code(201).send({ data: { address } });
  });

  app.patch('/v1/customer/me/addresses/:addressRef', {
    preHandler: [app.requireCustomerAuth],
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      label: { type: 'string', minLength: 1, maxLength: 80 }, recipient_name: { type: 'string', minLength: 1, maxLength: 160 },
      phone: { type: ['string','null'], maxLength: 60 }, country_code: { type: 'string', pattern: '^[A-Za-z]{2}$' },
      state: { type: ['string','null'], maxLength: 160 }, city: { type: 'string', minLength: 1, maxLength: 160 },
      postal_code: { type: ['string','null'], maxLength: 40 }, address_line_1: { type: 'string', minLength: 1, maxLength: 300 },
      address_line_2: { type: ['string','null'], maxLength: 300 }, delivery_note: { type: ['string','null'], maxLength: 1000 },
      is_default: { type: 'boolean' },
    } } },
  }, async (request) => app.db.transaction(async (client) => {
    const found = await client.query('SELECT * FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2 AND public_id=$3 FOR UPDATE', [request.auth.tenantId, request.auth.actorId, request.params.addressRef]);
    if (!found.rowCount) throw errors.notFound('CUSTOMER_ADDRESS_NOT_FOUND', 'Saved address not found');
    const cur = found.rows[0], b = request.body || {};
    const makeDefault = b.is_default ?? cur.is_default;
    if (makeDefault) await client.query('UPDATE customer_addresses SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND id<>$3', [request.auth.tenantId, request.auth.actorId, cur.id]);
    if (cur.is_default && b.is_default === false) throw errors.conflict('DEFAULT_ADDRESS_REQUIRED', 'Choose another default address before removing the default flag');
    const row = await client.query(
      `UPDATE customer_addresses SET label=$1,recipient_name=$2,phone=$3,country_code=$4,state=$5,city=$6,postal_code=$7,address_line_1=$8,address_line_2=$9,delivery_note=$10,is_default=$11,updated_at=now()
        WHERE tenant_id=$12 AND customer_id=$13 AND id=$14
        RETURNING public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,is_default,created_at,updated_at`,
      [b.label?.trim() ?? cur.label,b.recipient_name?.trim() ?? cur.recipient_name,Object.hasOwn(b,'phone')?b.phone:cur.phone,b.country_code?b.country_code.toUpperCase():cur.country_code,
        Object.hasOwn(b,'state')?b.state:cur.state,b.city?.trim() ?? cur.city,Object.hasOwn(b,'postal_code')?b.postal_code:cur.postal_code,b.address_line_1?.trim() ?? cur.address_line_1,
        Object.hasOwn(b,'address_line_2')?b.address_line_2:cur.address_line_2,Object.hasOwn(b,'delivery_note')?b.delivery_note:cur.delivery_note,Boolean(makeDefault),request.auth.tenantId,request.auth.actorId,cur.id],
    );
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.address.update', targetType: 'customer_address', targetId: cur.id,
      metadata: { changed_fields: Object.keys(b) }, requestIp: request.ip, requestId: request.id });
    return { data: { address: row.rows[0] } };
  }));

  app.delete('/v1/customer/me/addresses/:addressRef', { preHandler: [app.requireCustomerAuth] }, async (request) => app.db.transaction(async (client) => {
    const deleted = await client.query('DELETE FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2 AND public_id=$3 RETURNING id,is_default', [request.auth.tenantId, request.auth.actorId, request.params.addressRef]);
    if (!deleted.rowCount) throw errors.notFound('CUSTOMER_ADDRESS_NOT_FOUND', 'Saved address not found');
    if (deleted.rows[0].is_default) {
      await client.query(`UPDATE customer_addresses SET is_default=true,updated_at=now()
        WHERE id=(SELECT id FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2 ORDER BY updated_at DESC LIMIT 1)`, [request.auth.tenantId, request.auth.actorId]);
    }
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.address.delete', targetType: 'customer_address', targetId: deleted.rows[0].id,
      requestIp: request.ip, requestId: request.id });
    return { data: { deleted: true } };
  }));

  app.get('/v1/customer/me/sessions', { preHandler: [app.requireCustomerAuth] }, async (request) => {
    const rows = await app.db.query(
      `SELECT public_id AS id,user_agent,host(request_ip) AS request_ip,created_at,last_seen_at,expires_at,(id=$3) AS current
         FROM customer_sessions WHERE tenant_id=$1 AND customer_id=$2 AND revoked_at IS NULL AND expires_at>now()
        ORDER BY current DESC,last_seen_at DESC`, [request.auth.tenantId, request.auth.actorId, request.auth.sessionId],
    );
    return { data: { sessions: rows.rows } };
  });

  app.delete('/v1/customer/me/sessions/:sessionRef', { preHandler: [app.requireCustomerAuth] }, async (request) => app.db.transaction(async (client) => {
    const found = await client.query(
      `UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,now()),last_seen_at=now()
        WHERE tenant_id=$1 AND customer_id=$2 AND public_id=$3 AND revoked_at IS NULL RETURNING id`,
      [request.auth.tenantId, request.auth.actorId, request.params.sessionRef],
    );
    if (!found.rowCount) throw errors.notFound('CUSTOMER_SESSION_NOT_FOUND', 'Session not found');
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.session.revoke', targetType: 'customer_session', targetId: found.rows[0].id,
      requestIp: request.ip, requestId: request.id });
    return { data: { revoked: true, current_session: found.rows[0].id === request.auth.sessionId } };
  }));

  app.post('/v1/customer/me/sessions/revoke-others', { preHandler: [app.requireCustomerAuth] }, async (request) => app.db.transaction(async (client) => {
    const result = await client.query(
      `UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE tenant_id=$1 AND customer_id=$2 AND id<>$3 AND revoked_at IS NULL`,
      [request.auth.tenantId, request.auth.actorId, request.auth.sessionId],
    );
    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,
      action: 'customer.sessions.revoke_others', targetType: 'customer', targetId: request.auth.actorId,
      metadata: { sessions_revoked: result.rowCount }, requestIp: request.ip, requestId: request.id });
    return { data: { sessions_revoked: result.rowCount } };
  }));

}
