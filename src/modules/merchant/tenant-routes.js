import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { getTenantById } from '../tenants/service.js';
import { createStore, listStores, updateStore } from '../stores/service.js';
import { customerIdentitySettings, effectiveAuthOptions } from '../auth/customer-identity.js';

const storeBody = {
  type: 'object', additionalProperties: false, required: ['name','slug'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    slug: { type: 'string', minLength: 1, maxLength: 120 },
    is_primary: { type: 'boolean' },
    template_key: { type: 'string', minLength: 2, maxLength: 80 },
  },
};

export async function merchantTenantRoutes(app) {
  app.get('/v1/merchant/stores', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.STORES_READ)],
  }, async (request) => ({ data: { stores: await listStores(app.db, request.auth.tenantId) } }));

  app.post('/v1/merchant/stores', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.STORES_MANAGE)],
    schema: { body: storeBody },
  }, async (request, reply) => {
    const store = await app.db.transaction(async (client) => {
      const created = await createStore(client, {
        tenantId: request.auth.tenantId,
        name: request.body.name,
        slug: request.body.slug,
        isPrimary: request.body.is_primary,
        templateKey: request.body.template_key || 'MODERN_COMMERCE',
      });
      const internal = await client.query('SELECT id FROM stores WHERE tenant_id=$1 AND public_id=$2', [request.auth.tenantId, created.id]);
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'store.create', targetType: 'store', targetId: internal.rows[0]?.id || null,
        metadata: { public_id: created.id, slug: created.slug, is_primary: created.is_primary }, requestIp: request.ip, requestId: request.id });
      return created;
    });
    return reply.code(201).send({ data: { store } });
  });

  app.patch('/v1/merchant/stores/:storeRef', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.STORES_MANAGE)],
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 },
      slug: { type: 'string', minLength: 1, maxLength: 120 },
      status: { type: 'string', enum: ['ACTIVE','INACTIVE'] },
      is_primary: { type: 'boolean' },
    } } },
  }, async (request) => {
    const result = await app.db.transaction(async (client) => {
      const updated = await updateStore(client, { tenantId: request.auth.tenantId, storeRef: request.params.storeRef, patch: request.body || {} });
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'store.update', targetType: 'store', targetId: updated.internalId,
        metadata: { store_id: updated.row.id, changed_fields: Object.keys(request.body || {}) }, requestIp: request.ip, requestId: request.id });
      return updated.row;
    });
    return { data: { store: result } };
  });

  app.get('/v1/merchant/tenant', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async (request) => ({ data: { tenant: await getTenantById(app.db, request.auth.tenantId) } }));

  app.get('/v1/merchant/customer-auth/options', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async (request) => {
    const settings=await customerIdentitySettings(app.db,request.auth.tenantId);
    return { data: { auth: effectiveAuthOptions(settings,app.config), next_customer_code: `${settings.id_prefix}${String(settings.next_sequence).padStart(7,'0')}` } };
  });

  app.patch('/v1/merchant/tenant/settings', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.TENANT_SETTINGS_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      currency: { type: 'string', minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$' },
      locale: { type: 'string', minLength: 2, maxLength: 20 },
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
      branding: { type: 'object' },
      modules: { type: 'object' },
      customer_service: { type: 'object' },
      customer_identity: { type: 'object', additionalProperties: false, properties: { id_prefix:{type:'string',pattern:'^[A-Z]{2,6}$'}, auth_config:{type:'object',additionalProperties:false,properties:{email_password:{type:'boolean'},google:{type:'boolean'},telegram:{type:'boolean'},phone:{type:'boolean'},phone_countries:{type:'array',maxItems:40,uniqueItems:true,items:{type:'string',pattern:'^[A-Z]{2}$'}}} } } },
    } } },
  }, async (request) => {
    const body = request.body || {};
    const result = await app.db.transaction(async (client) => {
      const current = await client.query('SELECT * FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE', [request.auth.tenantId]);
      const row = current.rows[0];
      const identityCurrent=(await client.query('SELECT * FROM tenant_customer_identity_settings WHERE tenant_id=$1 FOR UPDATE',[request.auth.tenantId])).rows[0];
      const next = {
        currency: body.currency ?? row.currency,
        locale: body.locale ?? row.locale,
        timezone: body.timezone ?? row.timezone,
        branding: body.branding ? { ...row.branding, ...body.branding } : row.branding,
        modules: body.modules ? { ...row.modules, ...body.modules } : row.modules,
        customerService: body.customer_service ? { ...row.customer_service, ...body.customer_service } : row.customer_service,
      };
      if(body.customer_identity){const nextPrefix=body.customer_identity.id_prefix??identityCurrent.id_prefix;const nextAuth={...(identityCurrent.auth_config||{}),...(body.customer_identity.auth_config||{})};const effective=effectiveAuthOptions({id_prefix:nextPrefix,auth_config:nextAuth},app.config);if(!Object.values(effective.methods).some(method=>method.enabled))throw errors.conflict('CUSTOMER_AUTH_METHOD_REQUIRED','At least one production-ready customer login method must remain enabled');await client.query('UPDATE tenant_customer_identity_settings SET id_prefix=$1,auth_config=$2::jsonb,updated_at=now() WHERE tenant_id=$3',[nextPrefix,JSON.stringify(nextAuth),request.auth.tenantId]);}
      const updated = await client.query(
        `UPDATE tenant_settings SET currency=$1, locale=$2, timezone=$3, branding=$4::jsonb,
                modules=$5::jsonb, customer_service=$6::jsonb, updated_at=now()
          WHERE tenant_id=$7 RETURNING *`,
        [next.currency, next.locale, next.timezone, JSON.stringify(next.branding), JSON.stringify(next.modules),
          JSON.stringify(next.customerService), request.auth.tenantId],
      );
      await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'MERCHANT', actorId: request.auth.actorId,
        action: 'tenant.settings.update', targetType: 'tenant', targetId: request.auth.tenantId,
        metadata: { changed_fields: Object.keys(body) }, requestIp: request.ip, requestId: request.id });
      const identity=(await client.query('SELECT id_prefix,next_sequence,auth_config FROM tenant_customer_identity_settings WHERE tenant_id=$1',[request.auth.tenantId])).rows[0];
      return {...updated.rows[0],customer_identity:identity};
    });
    return { data: { settings: result } };
  });

  app.get('/v1/merchant/audit', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.AUDIT_READ)],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', maxLength: 160 }, actor_type: { type: 'string', maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 250, default: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
    } } },
  }, async (request) => {
    const values = [request.auth.tenantId];
    let where = 'a.tenant_id=$1';
    if (request.query.action) { values.push(`%${request.query.action}%`); where += ` AND a.action ILIKE $${values.length}`; }
    if (request.query.actor_type) { values.push(request.query.actor_type.toUpperCase()); where += ` AND a.actor_type=$${values.length}`; }
    values.push(request.query.limit || 100, request.query.offset || 0);
    const result = await app.db.query(
      `SELECT a.id,a.actor_type,a.action,a.target_type,a.metadata,a.request_id,a.request_ip,a.created_at,
              CASE WHEN a.actor_type='MERCHANT' THEN mu.display_name WHEN a.actor_type='CUSTOMER' THEN c.display_name ELSE a.actor_type END AS actor_name
         FROM audit_logs a
         LEFT JOIN merchant_users mu ON mu.id=a.actor_id AND mu.tenant_id=a.tenant_id
         LEFT JOIN customers c ON c.id=a.actor_id AND c.tenant_id=a.tenant_id
        WHERE ${where}
        ORDER BY a.created_at DESC,a.id DESC LIMIT $${values.length-1} OFFSET $${values.length}`,
      values,
    );
    return { data: { events: result.rows, limit: request.query.limit || 100, offset: request.query.offset || 0 } };
  });
}
