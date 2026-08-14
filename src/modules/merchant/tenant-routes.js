import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { getTenantById } from '../tenants/service.js';

export async function merchantTenantRoutes(app) {
  app.get('/v1/merchant/stores', {
    preHandler: [app.requireMerchantAuth],
  }, async (request) => {
    const result = await app.db.query(
      `SELECT public_id AS id,slug,name,status,is_primary,created_at,updated_at
         FROM stores WHERE tenant_id=$1 ORDER BY is_primary DESC,name`,
      [request.auth.tenantId],
    );
    return { data: { stores: result.rows } };
  });

  app.get('/v1/merchant/tenant', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async (request) => ({ data: { tenant: await getTenantById(app.db, request.auth.tenantId) } }));

  app.patch('/v1/merchant/tenant/settings', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.TENANT_SETTINGS_WRITE)],
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      currency: { type: 'string', minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$' },
      locale: { type: 'string', minLength: 2, maxLength: 20 },
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
      branding: { type: 'object' },
      modules: { type: 'object' },
      customer_service: { type: 'object' },
    } } },
  }, async (request) => {
    const body = request.body || {};
    const result = await app.db.transaction(async (client) => {
      const current = await client.query('SELECT * FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE', [request.auth.tenantId]);
      const row = current.rows[0];
      const next = {
        currency: body.currency ?? row.currency,
        locale: body.locale ?? row.locale,
        timezone: body.timezone ?? row.timezone,
        branding: body.branding ? { ...row.branding, ...body.branding } : row.branding,
        modules: body.modules ? { ...row.modules, ...body.modules } : row.modules,
        customerService: body.customer_service ? { ...row.customer_service, ...body.customer_service } : row.customer_service,
      };
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
      return updated.rows[0];
    });
    return { data: { settings: result } };
  });
}
