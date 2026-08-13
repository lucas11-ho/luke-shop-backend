import { resolveStore, resolveStoreBySlug } from '../catalog/service.js';
import { resolvePreviewToken, resolvePublicStorefront, storefrontPayload } from './context.js';

export async function storefrontRoutes(app) {
  app.get('/v1/storefront/resolve', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      tenant_slug: { type: 'string', maxLength: 63 }, store_slug: { type: 'string', maxLength: 120 }, hostname: { type: 'string', maxLength: 253 },
    } } },
  }, async (request) => {
    const context = await resolvePublicStorefront(app.db, app.config, {
      tenantSlug: request.query?.tenant_slug || null,
      storeSlug: request.query?.store_slug || null,
      hostname: request.query?.hostname || null,
    });
    return { data: await storefrontPayload(app.db, context) };
  });

  app.get('/v1/storefront/preview/:token', async (request) => {
    const context = await resolvePreviewToken(app.db, request.params.token);
    return { data: await storefrontPayload(app.db, { ...context, source: 'SIGNED_PREVIEW', preview: true }) };
  });

  app.get('/v1/storefront/promotions', { preHandler: [app.requireTenant] }, async (request) => {
    const store = request.headers['x-store-slug'] ? await resolveStoreBySlug(app.db, request.tenant.id, request.headers['x-store-slug']) : await resolveStore(app.db, request.tenant.id, request.headers['x-store-id'] || null);
    const rows = await app.db.query(`SELECT public_id AS id,name,promotion_type,value,starts_at,ends_at,COALESCE(schedule_timezone,ts.timezone,'UTC') AS schedule_timezone,metadata FROM promotions p LEFT JOIN tenant_settings ts ON ts.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.status IN ('ACTIVE','SCHEDULED') AND (p.starts_at IS NULL OR p.starts_at<=now()) AND (p.ends_at IS NULL OR p.ends_at>now()) ORDER BY p.created_at DESC LIMIT 20`,[request.tenant.id,store.id]);
    return {data:{promotions:rows.rows}};
  });

  app.get('/v1/storefront/config', { preHandler: [app.requireTenant] }, async (request) => {
    const store = request.headers['x-store-slug']
      ? await resolveStoreBySlug(app.db, request.tenant.id, request.headers['x-store-slug'])
      : await resolveStore(app.db, request.tenant.id, request.headers['x-store-id'] || null);
    return { data: await storefrontPayload(app.db, { tenant: request.tenant, store, source: 'HEADER' }) };
  });
}
