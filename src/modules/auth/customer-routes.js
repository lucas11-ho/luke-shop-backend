import { errors } from '../../core/errors.js';
import { normalizeEmail, publicId, uuid } from '../../core/identifiers.js';
import { createHash } from 'node:crypto';
import { resolveStore } from '../catalog/service.js';
import { allowedMime, extensionForMime, hasExpectedSignature, mediaTypeForMime, safeOriginalFilename, storagePublicUrl, writeAsset } from '../assets/storage.js';
import { allocateCustomerCode, createCustomerSession, customerIdentitySettings, effectiveAuthOptions, findOrCreateProviderCustomer, newOtp, normalizePhone, otpHash, providerReadiness, publicCustomer, verifyGoogleCredential, verifyTelegramPayload } from './customer-identity.js';
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


export async function customerAuthRoutes(app) {
  app.post('/v1/customer/auth/register', {
    preHandler: [app.requireTenant],
    config: { rateLimit: { max: app.config.authRateLimitMax, timeWindow: '1 minute' } },
    schema: { body: authBody },
  }, async (request, reply) => {
    const identitySettings = await customerIdentitySettings(app.db, request.tenant.id);
    const authOptions = effectiveAuthOptions(identitySettings, app.config);
    if (!authOptions.methods.email_password.enabled) throw errors.forbidden('EMAIL_PASSWORD_LOGIN_DISABLED', 'Email and password registration is not enabled for this store');
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
      const code=await allocateCustomerCode(client,request.tenant.id);
      const inserted = await client.query(
        `INSERT INTO customers(id, public_id, tenant_id, email, password_hash, display_name, status,customer_sequence,customer_code)
         VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8) RETURNING *`,
        [customerId, customerPublicId, request.tenant.id, email, passwordHash, displayName,code.sequence,code.code],
      );
      await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,email,verified_at) VALUES($1,$2,$3,$4,'EMAIL_PASSWORD',$5,$5,NULL)`,[uuid(),publicId('cid'),request.tenant.id,customerId,email]);
      await client.query(
        `INSERT INTO customer_status_history(tenant_id, customer_id, from_status, to_status, reason, changed_by_type)
         VALUES($1,$2,NULL,'ACTIVE','registration','CUSTOMER')`,
        [request.tenant.id, customerId],
      );
      const tokens = await createCustomerSession(app, client, request.tenant.id, customerId, request);
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
    const identitySettings = await customerIdentitySettings(app.db, request.tenant.id);
    const authOptions = effectiveAuthOptions(identitySettings, app.config);
    if (!authOptions.methods.email_password.enabled) throw errors.forbidden('EMAIL_PASSWORD_LOGIN_DISABLED', 'Email and password login is not enabled for this store');
    const email = normalizeEmail(request.body.email);
    const found = await app.db.query(
      `SELECT id, public_id, customer_code, email, phone_e164, avatar_url, display_name, status, password_hash
         FROM customers WHERE tenant_id = $1 AND email = $2`,
      [request.tenant.id, email],
    );
    const row = found.rows[0];
    const valid = row?.password_hash ? await verifyPassword(row.password_hash, request.body.password) : false;
    if (!valid) throw errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    if (row.status !== 'ACTIVE') throw errors.forbidden('CUSTOMER_NOT_ACTIVE', 'Customer account is not active');

    return app.db.transaction(async (client) => {
      const tokens = await createCustomerSession(app, client, request.tenant.id, row.id, request);
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
        WHERE tenant_id=$2 AND id=$3 RETURNING public_id,customer_code,email,phone_e164,avatar_url,display_name,status`,
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
    if (!found.rowCount || !found.rows[0].password_hash || !await verifyPassword(found.rows[0].password_hash, request.body.current_password)) {
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
      `SELECT public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,formatted_address,is_default,latitude,longitude,accuracy_meters,location_source,location_updated_at,created_at,updated_at
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
      address_line_2: { type: ['string','null'], maxLength: 300 }, delivery_note: { type: ['string','null'], maxLength: 1000 }, formatted_address:{type:['string','null'],maxLength:600},
      is_default: { type: 'boolean' }, latitude:{type:['number','null'],minimum:-90,maximum:90}, longitude:{type:['number','null'],minimum:-180,maximum:180},
      accuracy_meters:{type:['number','null'],minimum:0,maximum:100000}, location_source:{type:['string','null'],enum:['GPS','MAP_PIN','ADDRESS',null]},
    } } },
  }, async (request, reply) => {
    const address = await app.db.transaction(async (client) => {
      const count = await client.query('SELECT count(*)::int AS total FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2', [request.auth.tenantId, request.auth.actorId]);
      const makeDefault = Boolean(request.body.is_default) || Number(count.rows[0]?.total || 0) === 0;
      if (makeDefault) await client.query('UPDATE customer_addresses SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2', [request.auth.tenantId, request.auth.actorId]);
      const id = uuid(); const pid = publicId('addr');
      const row = await client.query(
        `INSERT INTO customer_addresses(id,public_id,tenant_id,customer_id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,formatted_address,is_default,latitude,longitude,accuracy_meters,location_source,location_updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,upper($8),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,CASE WHEN $17::double precision IS NULL OR $18::double precision IS NULL THEN NULL ELSE now() END)
         RETURNING public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,formatted_address,is_default,latitude,longitude,accuracy_meters,location_source,location_updated_at,created_at,updated_at`,
        [id,pid,request.auth.tenantId,request.auth.actorId,request.body.label.trim(),request.body.recipient_name.trim(),request.body.phone||null,request.body.country_code,
          request.body.state||null,request.body.city.trim(),request.body.postal_code||null,request.body.address_line_1.trim(),request.body.address_line_2||null,request.body.delivery_note||null,request.body.formatted_address||null,makeDefault,
          request.body.latitude??null,request.body.longitude??null,request.body.accuracy_meters??null,request.body.location_source||null],
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
      address_line_2: { type: ['string','null'], maxLength: 300 }, delivery_note: { type: ['string','null'], maxLength: 1000 }, formatted_address:{type:['string','null'],maxLength:600},
      is_default: { type: 'boolean' }, latitude:{type:['number','null'],minimum:-90,maximum:90}, longitude:{type:['number','null'],minimum:-180,maximum:180},
      accuracy_meters:{type:['number','null'],minimum:0,maximum:100000}, location_source:{type:['string','null'],enum:['GPS','MAP_PIN','ADDRESS',null]},
    } } },
  }, async (request) => app.db.transaction(async (client) => {
    const found = await client.query('SELECT * FROM customer_addresses WHERE tenant_id=$1 AND customer_id=$2 AND public_id=$3 FOR UPDATE', [request.auth.tenantId, request.auth.actorId, request.params.addressRef]);
    if (!found.rowCount) throw errors.notFound('CUSTOMER_ADDRESS_NOT_FOUND', 'Saved address not found');
    const cur = found.rows[0], b = request.body || {};
    const makeDefault = b.is_default ?? cur.is_default;
    if (makeDefault) await client.query('UPDATE customer_addresses SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND id<>$3', [request.auth.tenantId, request.auth.actorId, cur.id]);
    if (cur.is_default && b.is_default === false) throw errors.conflict('DEFAULT_ADDRESS_REQUIRED', 'Choose another default address before removing the default flag');
    const row = await client.query(
      `UPDATE customer_addresses SET label=$1,recipient_name=$2,phone=$3,country_code=$4,state=$5,city=$6,postal_code=$7,address_line_1=$8,address_line_2=$9,delivery_note=$10,formatted_address=$11,is_default=$12,
        latitude=$13,longitude=$14,accuracy_meters=$15,location_source=$16,location_updated_at=CASE WHEN $13::double precision IS DISTINCT FROM latitude OR $14::double precision IS DISTINCT FROM longitude OR $15::double precision IS DISTINCT FROM accuracy_meters OR $16::text IS DISTINCT FROM location_source THEN now() ELSE location_updated_at END,updated_at=now()
        WHERE tenant_id=$17 AND customer_id=$18 AND id=$19
        RETURNING public_id AS id,label,recipient_name,phone,country_code,state,city,postal_code,address_line_1,address_line_2,delivery_note,formatted_address,is_default,latitude,longitude,accuracy_meters,location_source,location_updated_at,created_at,updated_at`,
      [b.label?.trim() ?? cur.label,b.recipient_name?.trim() ?? cur.recipient_name,Object.hasOwn(b,'phone')?b.phone:cur.phone,b.country_code?b.country_code.toUpperCase():cur.country_code,
        Object.hasOwn(b,'state')?b.state:cur.state,b.city?.trim() ?? cur.city,Object.hasOwn(b,'postal_code')?b.postal_code:cur.postal_code,b.address_line_1?.trim() ?? cur.address_line_1,
        Object.hasOwn(b,'address_line_2')?b.address_line_2:cur.address_line_2,Object.hasOwn(b,'delivery_note')?b.delivery_note:cur.delivery_note,Object.hasOwn(b,'formatted_address')?b.formatted_address:cur.formatted_address,Boolean(makeDefault),
        Object.hasOwn(b,'latitude')?b.latitude:cur.latitude,Object.hasOwn(b,'longitude')?b.longitude:cur.longitude,Object.hasOwn(b,'accuracy_meters')?b.accuracy_meters:cur.accuracy_meters,Object.hasOwn(b,'location_source')?b.location_source:cur.location_source,
        request.auth.tenantId,request.auth.actorId,cur.id],
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


  app.get('/v1/customer/auth/options',{preHandler:[app.requireTenant]},async request=>{const settings=await customerIdentitySettings(app.db,request.tenant.id);return {data:{auth:effectiveAuthOptions(settings,app.config)}};});

  app.post('/v1/customer/auth/google',{preHandler:[app.requireTenant],config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['credential'],properties:{credential:{type:'string',minLength:20,maxLength:10000}}}}},async request=>{const settings=await customerIdentitySettings(app.db,request.tenant.id),opts=effectiveAuthOptions(settings,app.config);if(!opts.methods.google.enabled)throw errors.forbidden('GOOGLE_LOGIN_DISABLED','Google login is not enabled for this store');const profile=await verifyGoogleCredential(app.config,request.body.credential);return app.db.transaction(async client=>{const row=await findOrCreateProviderCustomer(app,client,{tenantId:request.tenant.id,provider:'GOOGLE',subject:String(profile.sub),displayName:String(profile.name||profile.email||'Customer'),email:String(profile.email),avatarUrl:profile.picture?String(profile.picture):null,metadata:{email_verified:true},request});if(row.status!=='ACTIVE')throw errors.forbidden('CUSTOMER_NOT_ACTIVE','Customer account is not active');const tokens=await createCustomerSession(app,client,request.tenant.id,row.id,request);await client.query('UPDATE customers SET last_login_at=now(),updated_at=now() WHERE id=$1',[row.id]);return {data:{customer:publicCustomer(row),tokens}};});});

  app.post('/v1/customer/auth/telegram',{preHandler:[app.requireTenant],config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:true,required:['id','auth_date','hash'],properties:{id:{},auth_date:{},hash:{type:'string'},first_name:{type:'string'},last_name:{type:'string'},username:{type:'string'},photo_url:{type:'string'}}}}},async request=>{const settings=await customerIdentitySettings(app.db,request.tenant.id),opts=effectiveAuthOptions(settings,app.config);if(!opts.methods.telegram.enabled)throw errors.forbidden('TELEGRAM_LOGIN_DISABLED','Telegram login is not enabled for this store');const t=verifyTelegramPayload(app.config,request.body);return app.db.transaction(async client=>{const row=await findOrCreateProviderCustomer(app,client,{tenantId:request.tenant.id,provider:'TELEGRAM',subject:String(t.id),displayName:[t.first_name,t.last_name].filter(Boolean).join(' ')||t.username||'Telegram customer',avatarUrl:t.photo_url||null,metadata:{username:t.username||null},request});if(row.status!=='ACTIVE')throw errors.forbidden('CUSTOMER_NOT_ACTIVE','Customer account is not active');const tokens=await createCustomerSession(app,client,request.tenant.id,row.id,request);await client.query('UPDATE customers SET last_login_at=now(),updated_at=now() WHERE id=$1',[row.id]);return {data:{customer:publicCustomer(row),tokens}};});});

  app.post('/v1/customer/auth/phone/request',{preHandler:[app.requireTenant],config:{rateLimit:{max:5,timeWindow:'10 minutes'}},schema:{body:{type:'object',additionalProperties:false,required:['calling_code','phone_number','country_code'],properties:{calling_code:{type:'string',minLength:1,maxLength:6},phone_number:{type:'string',minLength:5,maxLength:30},country_code:{type:'string',pattern:'^[A-Za-z]{2}$'}}}}},async(request,reply)=>{const settings=await customerIdentitySettings(app.db,request.tenant.id),opts=effectiveAuthOptions(settings,app.config);if(!opts.methods.phone.enabled)throw errors.unavailable('PHONE_LOGIN_NOT_CONFIGURED','Phone login is not available');const country=request.body.country_code.toUpperCase();if(!opts.methods.phone.countries.includes(country))throw errors.badRequest('PHONE_COUNTRY_NOT_ALLOWED','This country is not enabled for phone login');const phone=normalizePhone(request.body.calling_code,request.body.phone_number),pid=publicId('otp'),code=newOtp(),hash=otpHash(app.config.customerPhoneOtpHashSecret,pid,phone,code);await app.db.query(`INSERT INTO customer_phone_otp_challenges(public_id,tenant_id,phone_e164,country_code,code_hash,expires_at,request_ip) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes',$6)`,[pid,request.tenant.id,phone,country,hash,request.ip||null]);let res;try{res=await fetch(app.config.customerPhoneOtpWebhookUrl,{method:'POST',headers:{'Content-Type':'application/json',...(app.config.customerPhoneOtpWebhookBearer?{Authorization:`Bearer ${app.config.customerPhoneOtpWebhookBearer}`}:{})},body:JSON.stringify({tenant_slug:request.tenant.slug,phone_e164:phone,code,expires_in:300})});}catch{throw errors.unavailable('PHONE_OTP_DELIVERY_FAILED','OTP provider could not be reached');}if(!res.ok)throw errors.unavailable('PHONE_OTP_DELIVERY_FAILED','OTP provider rejected the delivery request');return reply.code(201).send({data:{challenge_id:pid,phone_masked:`${phone.slice(0,Math.max(3,phone.length-4)).replace(/\d/g,'•')}${phone.slice(-4)}`,expires_in:300}});});

  app.post('/v1/customer/auth/phone/verify',{preHandler:[app.requireTenant],config:{rateLimit:{max:10,timeWindow:'10 minutes'}},schema:{body:{type:'object',additionalProperties:false,required:['challenge_id','code'],properties:{challenge_id:{type:'string',minLength:8,maxLength:140},code:{type:'string',pattern:'^[0-9]{6}$'}}}}},async request=>app.db.transaction(async client=>{const challenge=(await client.query(`SELECT * FROM customer_phone_otp_challenges WHERE tenant_id=$1 AND public_id=$2 FOR UPDATE`,[request.tenant.id,request.body.challenge_id])).rows[0];if(!challenge||challenge.consumed_at||new Date(challenge.expires_at)<=new Date())throw errors.unauthorized('PHONE_OTP_INVALID','OTP is invalid or expired');if(challenge.attempts>=5)throw errors.tooManyRequests?.('PHONE_OTP_LOCKED','Too many OTP attempts')||errors.unauthorized('PHONE_OTP_LOCKED','Too many OTP attempts');const actual=otpHash(app.config.customerPhoneOtpHashSecret,challenge.public_id,challenge.phone_e164,request.body.code);if(actual!==challenge.code_hash){await client.query('UPDATE customer_phone_otp_challenges SET attempts=attempts+1 WHERE id=$1',[challenge.id]);throw errors.unauthorized('PHONE_OTP_INVALID','OTP is invalid or expired');}await client.query('UPDATE customer_phone_otp_challenges SET consumed_at=now() WHERE id=$1',[challenge.id]);const row=await findOrCreateProviderCustomer(app,client,{tenantId:request.tenant.id,provider:'PHONE',subject:challenge.phone_e164,displayName:`Member ${challenge.phone_e164.slice(-4)}`,phone:challenge.phone_e164,countryCode:challenge.country_code,request});if(row.status!=='ACTIVE')throw errors.forbidden('CUSTOMER_NOT_ACTIVE','Customer account is not active');const tokens=await createCustomerSession(app,client,request.tenant.id,row.id,request);await client.query('UPDATE customers SET last_login_at=now(),phone_verified_at=COALESCE(phone_verified_at,now()),updated_at=now() WHERE id=$1',[row.id]);return {data:{customer:publicCustomer({...row,phone_e164:challenge.phone_e164}),tokens}};}));

  app.post('/v1/customer/me/auth-identities/google',{preHandler:[app.requireCustomerAuth],config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['credential'],properties:{credential:{type:'string',minLength:20,maxLength:10000}}}}},async request=>app.db.transaction(async client=>{const settings=await customerIdentitySettings(client,request.auth.tenantId),opts=effectiveAuthOptions(settings,app.config);if(!opts.methods.google.enabled)throw errors.forbidden('GOOGLE_LOGIN_DISABLED','Google login is not enabled');const profile=await verifyGoogleCredential(app.config,request.body.credential);const subject=String(profile.sub);const occupied=await client.query(`SELECT customer_id FROM customer_auth_identities WHERE tenant_id=$1 AND provider='GOOGLE' AND provider_subject=$2`,[request.auth.tenantId,subject]);if(occupied.rowCount&&occupied.rows[0].customer_id!==request.auth.actorId)throw errors.conflict('LOGIN_IDENTITY_IN_USE','This Google account is already connected to another customer');await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,email,metadata,verified_at) VALUES($1,$2,$3,$4,'GOOGLE',$5,$6,$7::jsonb,now()) ON CONFLICT(tenant_id,customer_id,provider) DO UPDATE SET provider_subject=EXCLUDED.provider_subject,email=EXCLUDED.email,metadata=EXCLUDED.metadata,verified_at=now(),updated_at=now()`,[uuid(),publicId('cid'),request.auth.tenantId,request.auth.actorId,subject,String(profile.email||''),JSON.stringify({email_verified:true})]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'customer.login_identity.link',targetType:'customer',targetId:request.auth.actorId,metadata:{provider:'GOOGLE'},requestIp:request.ip,requestId:request.id});return {data:{linked:true,provider:'GOOGLE'}};}));

  app.post('/v1/customer/me/auth-identities/telegram',{preHandler:[app.requireCustomerAuth],config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:true,required:['id','auth_date','hash'],properties:{id:{},auth_date:{},hash:{type:'string'},first_name:{type:'string'},last_name:{type:'string'},username:{type:'string'},photo_url:{type:'string'}}}}},async request=>app.db.transaction(async client=>{const settings=await customerIdentitySettings(client,request.auth.tenantId),opts=effectiveAuthOptions(settings,app.config);if(!opts.methods.telegram.enabled)throw errors.forbidden('TELEGRAM_LOGIN_DISABLED','Telegram login is not enabled');const t=verifyTelegramPayload(app.config,request.body),subject=String(t.id);const occupied=await client.query(`SELECT customer_id FROM customer_auth_identities WHERE tenant_id=$1 AND provider='TELEGRAM' AND provider_subject=$2`,[request.auth.tenantId,subject]);if(occupied.rowCount&&occupied.rows[0].customer_id!==request.auth.actorId)throw errors.conflict('LOGIN_IDENTITY_IN_USE','This Telegram account is already connected to another customer');await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,metadata,verified_at) VALUES($1,$2,$3,$4,'TELEGRAM',$5,$6::jsonb,now()) ON CONFLICT(tenant_id,customer_id,provider) DO UPDATE SET provider_subject=EXCLUDED.provider_subject,metadata=EXCLUDED.metadata,verified_at=now(),updated_at=now()`,[uuid(),publicId('cid'),request.auth.tenantId,request.auth.actorId,subject,JSON.stringify({username:t.username||null})]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'customer.login_identity.link',targetType:'customer',targetId:request.auth.actorId,metadata:{provider:'TELEGRAM'},requestIp:request.ip,requestId:request.id});return {data:{linked:true,provider:'TELEGRAM'}};}));

  app.post('/v1/customer/me/auth-identities/phone/verify',{preHandler:[app.requireCustomerAuth],config:{rateLimit:{max:10,timeWindow:'10 minutes'}},schema:{body:{type:'object',additionalProperties:false,required:['challenge_id','code'],properties:{challenge_id:{type:'string',minLength:8,maxLength:140},code:{type:'string',pattern:'^[0-9]{6}$'}}}}},async request=>app.db.transaction(async client=>{const challenge=(await client.query(`SELECT * FROM customer_phone_otp_challenges WHERE tenant_id=$1 AND public_id=$2 FOR UPDATE`,[request.auth.tenantId,request.body.challenge_id])).rows[0];if(!challenge||challenge.consumed_at||new Date(challenge.expires_at)<=new Date())throw errors.unauthorized('PHONE_OTP_INVALID','OTP is invalid or expired');const actual=otpHash(app.config.customerPhoneOtpHashSecret,challenge.public_id,challenge.phone_e164,request.body.code);if(actual!==challenge.code_hash){await client.query('UPDATE customer_phone_otp_challenges SET attempts=attempts+1 WHERE id=$1',[challenge.id]);throw errors.unauthorized('PHONE_OTP_INVALID','OTP is invalid or expired');}const occupiedCustomer=await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND phone_e164=$2 AND id<>$3',[request.auth.tenantId,challenge.phone_e164,request.auth.actorId]);if(occupiedCustomer.rowCount)throw errors.conflict('PHONE_IN_USE','This phone number belongs to another customer account');const occupiedIdentity=await client.query(`SELECT customer_id FROM customer_auth_identities WHERE tenant_id=$1 AND provider='PHONE' AND provider_subject=$2`,[request.auth.tenantId,challenge.phone_e164]);if(occupiedIdentity.rowCount&&occupiedIdentity.rows[0].customer_id!==request.auth.actorId)throw errors.conflict('LOGIN_IDENTITY_IN_USE','This phone number is already connected to another customer');await client.query('UPDATE customer_phone_otp_challenges SET consumed_at=now() WHERE id=$1',[challenge.id]);await client.query(`UPDATE customers SET phone_e164=$1,phone_country_code=$2,phone_verified_at=now(),updated_at=now() WHERE tenant_id=$3 AND id=$4`,[challenge.phone_e164,challenge.country_code,request.auth.tenantId,request.auth.actorId]);await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,phone_e164,verified_at) VALUES($1,$2,$3,$4,'PHONE',$5,$5,now()) ON CONFLICT(tenant_id,customer_id,provider) DO UPDATE SET provider_subject=EXCLUDED.provider_subject,phone_e164=EXCLUDED.phone_e164,verified_at=now(),updated_at=now()`,[uuid(),publicId('cid'),request.auth.tenantId,request.auth.actorId,challenge.phone_e164]);await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'customer.login_identity.link',targetType:'customer',targetId:request.auth.actorId,metadata:{provider:'PHONE'},requestIp:request.ip,requestId:request.id});return {data:{linked:true,provider:'PHONE',phone_e164:challenge.phone_e164}};}));

  app.get('/v1/customer/me/auth-identities',{preHandler:[app.requireCustomerAuth]},async request=>{const rows=await app.db.query(`SELECT provider,email,phone_e164,verified_at,created_at FROM customer_auth_identities WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at`,[request.auth.tenantId,request.auth.actorId]);return {data:{identities:rows.rows}};});

  for(const mime of ['image/jpeg','image/png','image/webp'])if(!app.hasContentTypeParser(mime))app.addContentTypeParser(mime,{parseAs:'buffer',bodyLimit:app.config.assetImageMaxBytes},(_req,body,done)=>done(null,body));
  app.post('/v1/customer/me/avatar',{bodyLimit:app.config.assetImageMaxBytes,preHandler:[app.requireCustomerAuth],schema:{querystring:{type:'object',additionalProperties:false,required:['filename'],properties:{filename:{type:'string',minLength:1,maxLength:240}}}}},async(request,reply)=>{const mime=String(request.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(!['image/jpeg','image/png','image/webp'].includes(mime)||!allowedMime(mime))throw errors.badRequest('AVATAR_TYPE_UNSUPPORTED','Use JPEG, PNG, or WEBP');if(!Buffer.isBuffer(request.body)||!request.body.length)throw errors.badRequest('AVATAR_FILE_REQUIRED','Choose an image to upload');if(request.body.length>Math.min(app.config.assetImageMaxBytes,5*1024*1024))throw errors.badRequest('AVATAR_FILE_TOO_LARGE','Profile image must be 5 MB or smaller');if(!hasExpectedSignature(request.body,mime))throw errors.badRequest('AVATAR_SIGNATURE_INVALID','Uploaded image bytes do not match the declared type');const store=await resolveStore(app.db,request.auth.tenantId,request.headers['x-store-id']||null,{requireActive:false}),pid=publicId('ast'),ext=extensionForMime(mime),storageKey=`${request.auth.tenantId}/${store.id}/avatars/${pid}${ext}`,url=storagePublicUrl(app.config,storageKey,pid),digest=createHash('sha256').update(request.body).digest('hex');await writeAsset(app.config,storageKey,request.body,mime);const customer=await app.db.transaction(async client=>{const aid=uuid();await client.query(`INSERT INTO media_assets(id,public_id,tenant_id,store_id,storage_provider,storage_key,visibility,media_type,mime_type,original_filename,file_size,sha256,url,metadata) VALUES($1,$2,$3,$4,$5,$6,'PUBLIC',$7,$8,$9,$10,$11,$12,$13::jsonb)`,[aid,pid,request.auth.tenantId,store.id,app.config.assetStorageDriver,storageKey,mediaTypeForMime(mime),mime,safeOriginalFilename(request.query.filename),request.body.length,digest,url,JSON.stringify({purpose:'CUSTOMER_AVATAR',customer_id:request.auth.profile.public_id})]);const r=(await client.query(`UPDATE customers SET avatar_asset_id=$1,avatar_url=$2,updated_at=now() WHERE tenant_id=$3 AND id=$4 RETURNING public_id,customer_code,email,phone_e164,avatar_url,display_name,status`,[aid,url,request.auth.tenantId,request.auth.actorId])).rows[0];await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'customer.avatar.update',targetType:'customer',targetId:request.auth.actorId,metadata:{asset_id:pid},requestIp:request.ip,requestId:request.id});return r;});return reply.code(201).send({data:{customer:publicCustomer(customer)}});});

  app.post('/v1/customer/location/reverse-geocode',{preHandler:[app.requireCustomerAuth],config:{rateLimit:{max:30,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['latitude','longitude'],properties:{latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180}}}}},async request=>{if(app.config.geocodingProvider!=='NOMINATIM')throw errors.unavailable('GEOCODING_NOT_CONFIGURED','Address lookup is not configured');const url=new URL(`${app.config.geocodingBaseUrl}/reverse`);url.searchParams.set('format','jsonv2');url.searchParams.set('addressdetails','1');url.searchParams.set('lat',String(request.body.latitude));url.searchParams.set('lon',String(request.body.longitude));let r;try{r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'LukeShop/0.13 customer-address'}});}catch{throw errors.unavailable('GEOCODING_UNAVAILABLE','Address lookup provider is unavailable');}if(!r.ok)throw errors.unavailable('GEOCODING_UNAVAILABLE','Address lookup provider returned an error');const j=await r.json(),a=j.address||{};return {data:{address:{formatted_address:j.display_name||null,address_line_1:[a.house_number,a.road||a.pedestrian||a.residential].filter(Boolean).join(' ')||a.neighbourhood||a.suburb||'',address_line_2:a.neighbourhood||a.suburb||null,city:a.city||a.town||a.village||a.municipality||'',state:a.state||a.region||null,postal_code:a.postcode||null,country_code:String(a.country_code||'').toUpperCase()||null}}};});

}
