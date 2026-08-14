import { errors } from '../../core/errors.js';
import { normalizeSlug, publicId, uuid } from '../../core/identifiers.js';
import { ensureStoreCommerceDefaults } from '../commerce/defaults.js';
import { normalizeExperienceConfig } from '../customer-experience/service.js';

async function tenantStoreLimit(client, tenantId) {
  const result = await client.query(
    `SELECT COALESCE((pl.limits->>'stores')::int, 1) AS plan_limit,
            CASE WHEN p.limits ? 'stores' THEN (p.limits->>'stores')::int ELSE NULL END AS override_limit
       FROM tenant_platform_profiles p
       JOIN platform_plans pl ON pl.key=p.plan_key
      WHERE p.tenant_id=$1`, [tenantId],
  );
  if (!result.rowCount) return 1;
  const row = result.rows[0];
  return Number(row.override_limit ?? row.plan_limit ?? 1);
}

async function defaultTemplate(client, templateKey = 'MODERN_COMMERCE') {
  const result = await client.query(
    `SELECT key,config FROM platform_storefront_templates
      WHERE key=$1 AND status='ACTIVE'`, [templateKey],
  );
  if (!result.rowCount) throw errors.conflict('STOREFRONT_TEMPLATE_MISSING', 'Default storefront template is unavailable');
  return result.rows[0];
}

export async function listStores(db, tenantId) {
  const result = await db.query(
    `SELECT public_id AS id,slug,name,status,is_primary,created_at,updated_at,
            (SELECT count(*)::int FROM orders o WHERE o.tenant_id=s.tenant_id AND o.store_id=s.id) AS orders,
            (SELECT count(*)::int FROM products p WHERE p.tenant_id=s.tenant_id AND p.store_id=s.id) AS products
       FROM stores s WHERE tenant_id=$1
      ORDER BY is_primary DESC,name`, [tenantId],
  );
  return result.rows;
}

export async function createStore(client, { tenantId, name, slug, isPrimary = false, templateKey = 'MODERN_COMMERCE' }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw errors.badRequest('STORE_NAME_REQUIRED', 'Store name is required');
  let normalizedSlug;
  try { normalizedSlug = normalizeSlug(slug); }
  catch (error) { throw errors.badRequest('STORE_SLUG_INVALID', error.message); }

  const limit = await tenantStoreLimit(client, tenantId);
  const count = await client.query('SELECT count(*)::int AS total FROM stores WHERE tenant_id=$1', [tenantId]);
  if (Number(count.rows[0]?.total || 0) >= limit) {
    throw errors.conflict('STORE_LIMIT_REACHED', `This tenant plan allows up to ${limit} store${limit === 1 ? '' : 's'}`);
  }

  const template = await defaultTemplate(client, templateKey);
  const id = uuid();
  const pid = publicId('str');
  const existing = Number(count.rows[0]?.total || 0);
  const makePrimary = existing === 0 || Boolean(isPrimary);
  if (makePrimary) await client.query('UPDATE stores SET is_primary=false,updated_at=now() WHERE tenant_id=$1', [tenantId]);

  const inserted = await client.query(
    `INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary)
     VALUES($1,$2,$3,$4,$5,'ACTIVE',$6)
     RETURNING id,public_id AS id_public,slug,name,status,is_primary,created_at,updated_at`,
    [id, pid, tenantId, normalizedSlug, trimmedName, makePrimary],
  );

  await client.query(
    `INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default)
     VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)`,
    [uuid(), publicId('loc'), tenantId, id],
  );
  await ensureStoreCommerceDefaults(client, { tenantId, storeId: id });

  const experience = structuredClone(template.config || {});
  experience.branding = { ...(experience.branding || {}), store_name: trimmedName };
  const normalized = normalizeExperienceConfig(experience);
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version,published_at)
     VALUES($1,$2,$3,$4,1,'PUBLISHED',$5::jsonb,$6,$6,false,3,now())`,
    [uuid(), publicId('sfx'), tenantId, id, JSON.stringify(normalized), template.key],
  );
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version)
     VALUES($1,$2,$3,$4,2,'DRAFT',$5::jsonb,$6,$6,false,3)`,
    [uuid(), publicId('sfx'), tenantId, id, JSON.stringify(normalized), template.key],
  );

  return { id: pid, slug: normalizedSlug, name: trimmedName, status: 'ACTIVE', is_primary: makePrimary,
    created_at: inserted.rows[0].created_at, updated_at: inserted.rows[0].updated_at };
}

export async function updateStore(client, { tenantId, storeRef, patch }) {
  const found = await client.query(
    'SELECT * FROM stores WHERE tenant_id=$1 AND (public_id=$2 OR slug=$2) FOR UPDATE', [tenantId, storeRef],
  );
  if (!found.rowCount) throw errors.notFound('STORE_NOT_FOUND', 'Store not found');
  const current = found.rows[0];
  let slug = current.slug;
  if (Object.hasOwn(patch, 'slug')) {
    try { slug = normalizeSlug(patch.slug); }
    catch (error) { throw errors.badRequest('STORE_SLUG_INVALID', error.message); }
  }
  const name = Object.hasOwn(patch, 'name') ? String(patch.name || '').trim() : current.name;
  if (!name) throw errors.badRequest('STORE_NAME_REQUIRED', 'Store name is required');
  const status = patch.status ?? current.status;
  const isPrimary = patch.is_primary ?? current.is_primary;
  if (current.is_primary && status !== 'ACTIVE') {
    throw errors.conflict('PRIMARY_STORE_MUST_BE_ACTIVE', 'Choose another primary store before deactivating this store');
  }
  if (current.is_primary && patch.is_primary === false) {
    throw errors.conflict('PRIMARY_STORE_REQUIRED', 'A tenant must keep one primary store. Make another store primary instead');
  }
  if (isPrimary && status !== 'ACTIVE') throw errors.conflict('PRIMARY_STORE_MUST_BE_ACTIVE', 'Primary store must be active');
  if (isPrimary && !current.is_primary) {
    await client.query('UPDATE stores SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND id<>$2', [tenantId, current.id]);
  }
  const updated = await client.query(
    `UPDATE stores SET slug=$1,name=$2,status=$3,is_primary=$4,updated_at=now()
      WHERE tenant_id=$5 AND id=$6
      RETURNING public_id AS id,slug,name,status,is_primary,created_at,updated_at`,
    [slug, name, status, Boolean(isPrimary), tenantId, current.id],
  );
  return { row: updated.rows[0], internalId: current.id };
}
