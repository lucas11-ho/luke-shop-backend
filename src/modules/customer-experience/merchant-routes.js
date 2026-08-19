import { createHash, randomBytes } from 'node:crypto';
import { PERMISSIONS } from '../../core/permissions.js';
import { errors } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { applyExperienceTemplate, loadExperience, loadExperienceCatalog, updateDraft, publishDraft, rollbackExperience } from './service.js';
import { loadTenantExperiencePolicy } from './extension-normalizer.js';

const storeHeader = (request) => request.headers['x-store-id'] || null;

async function storefrontMeta(db, tenantId, store) {
  const tenant = await db.query('SELECT slug FROM tenants WHERE id=$1', [tenantId]);
  const tenantSlug = tenant.rows[0]?.slug || null;
  return {
    tenant_slug: tenantSlug,
    store: { id: store.public_id, slug: store.slug || null, name: store.name, is_primary: store.is_primary },
    storefront_path: tenantSlug ? `/t/${tenantSlug}${store.is_primary || !store.slug || store.slug === 'main' ? '' : `/s/${store.slug}`}` : null,
  };
}

export async function merchantCustomerExperienceRoutes(app) {
  app.get('/v1/merchant/customer-experience/catalog', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async () => ({ data: await loadExperienceCatalog(app.db) }));

  app.get('/v1/merchant/customer-experience', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const [experience, meta, experiencePolicy] = await Promise.all([
      loadExperience(app.db, request.auth.tenantId, store.id),
      storefrontMeta(app.db, request.auth.tenantId, store),
      loadTenantExperiencePolicy(app.db, request.auth.tenantId),
    ]);
    return { data: { ...meta, ...experience, experience_policy: experiencePolicy } };
  });

  app.put('/v1/merchant/customer-experience/draft', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema: { body: { type:'object', additionalProperties:false, required:['config'], properties:{ config:{type:'object'} } } },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const draft = await app.db.transaction(async (client) => {
      const saved = await updateDraft(client, { tenantId:request.auth.tenantId, storeId:store.id, actorId:request.auth.actorId, config:request.body.config });
      await writeAudit(client, { tenantId:request.auth.tenantId, actorType:'MERCHANT', actorId:request.auth.actorId,
        action:'customer_experience.draft.update', targetType:'store', targetId:store.id, metadata:{version:saved.version}, requestIp:request.ip, requestId:request.id });
      return saved;
    });
    return { data: { draft } };
  });

  app.post('/v1/merchant/customer-experience/apply-template', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema: { body:{type:'object',additionalProperties:false,required:['template_key'],properties:{template_key:{type:'string',minLength:1,maxLength:80},mode:{type:'string',enum:['layout','theme','full']},keep_content:{type:'boolean'}}} },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const draft = await app.db.transaction(async (client) => {
      const saved = await applyExperienceTemplate(client,{tenantId:request.auth.tenantId,storeId:store.id,actorId:request.auth.actorId,templateKey:request.body.template_key,mode:request.body.mode||'full',keepContent:request.body.keep_content!==false});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'customer_experience.template.apply',targetType:'store',targetId:store.id,metadata:{template_key:request.body.template_key,mode:request.body.mode||'full',keep_content:request.body.keep_content!==false,version:saved.version},requestIp:request.ip,requestId:request.id});
      return saved;
    });
    return {data:{draft}};
  });

  app.post('/v1/merchant/customer-experience/preview-token', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const draft = await app.db.query(
      `SELECT version FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='DRAFT' LIMIT 1`,
      [request.auth.tenantId, store.id],
    );
    if (!draft.rowCount) throw errors.conflict('CUSTOMER_EXPERIENCE_DRAFT_REQUIRED', 'Save a draft before creating a preview link');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + app.config.storefrontPreviewTtlSeconds * 1000);
    await app.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO storefront_preview_tokens(token_hash,tenant_id,store_id,experience_version,created_by,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [tokenHash, request.auth.tenantId, store.id, draft.rows[0].version, request.auth.actorId, expiresAt],
      );
      await writeAudit(client, { tenantId:request.auth.tenantId, actorType:'MERCHANT', actorId:request.auth.actorId,
        action:'customer_experience.preview.issue', targetType:'store', targetId:store.id,
        metadata:{version:draft.rows[0].version,expires_at:expiresAt.toISOString()}, requestIp:request.ip, requestId:request.id });
    });
    return { data: { preview_token: token, preview_path: `/preview/${token}`, expires_at: expiresAt.toISOString() } };
  });

  app.post('/v1/merchant/customer-experience/publish', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_PUBLISH)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const published = await app.db.transaction(async (client) => {
      const row = await publishDraft(client, { tenantId:request.auth.tenantId, storeId:store.id, actorId:request.auth.actorId });
      await client.query('UPDATE storefront_preview_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL', [request.auth.tenantId, store.id]);
      await writeAudit(client, { tenantId:request.auth.tenantId, actorType:'MERCHANT', actorId:request.auth.actorId,
        action:'customer_experience.publish', targetType:'store', targetId:store.id, metadata:{version:row.version}, requestIp:request.ip, requestId:request.id });
      return row;
    });
    return { data: { published } };
  });

  app.post('/v1/merchant/customer-experience/rollback', {
    preHandler: [app.requireMerchantAuth, app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_PUBLISH)],
    schema: { body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}} },
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const published = await app.db.transaction(async (client) => {
      const row = await rollbackExperience(client, { tenantId:request.auth.tenantId, storeId:store.id, actorId:request.auth.actorId, version:request.body.version });
      await client.query('UPDATE storefront_preview_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL', [request.auth.tenantId, store.id]);
      await writeAudit(client, { tenantId:request.auth.tenantId, actorType:'MERCHANT', actorId:request.auth.actorId,
        action:'customer_experience.rollback', targetType:'store', targetId:store.id, metadata:{source_version:request.body.version,published_version:row.version}, requestIp:request.ip, requestId:request.id });
      return row;
    });
    return { data: { published } };
  });
}
