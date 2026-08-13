import { hashPassword, assertPasswordPolicy } from '../../core/passwords.js';
import { normalizeEmail, normalizeSlug, publicId, uuid } from '../../core/identifiers.js';
import { ALL_PERMISSIONS } from '../../core/permissions.js';
import { ensureStoreCommerceDefaults } from '../commerce/defaults.js';
import { ensureCustomerServicePolicy } from '../integrations/customer-service/policy.js';
import { normalizeExperienceConfig } from '../customer-experience/service.js';

const defaultSupport = (enabled) => ({
  enabled: Boolean(enabled), provider: 'LUKE_CS', label: 'Customer Support',
  placement: { floating: false, home: false, profile: false, order_detail: false, product_detail: false, checkout: false },
});

export async function provisionTenant(client, input, { platformUserId = null } = {}) {
  const slug = normalizeSlug(input.slug);
  const name = String(input.name || '').trim();
  const email = normalizeEmail(input.owner_email);
  const password = assertPasswordPolicy(input.owner_password);
  if (!name) throw new Error('Tenant name is required');
  if (!email) throw new Error('Owner email is required');

  const planKey = String(input.plan_key || 'STARTER').trim().toUpperCase();
  const planResult = await client.query('SELECT * FROM platform_plans WHERE key=$1 AND status=\'ACTIVE\'', [planKey]);
  if (!planResult.rowCount) throw new Error(`Active platform plan not found: ${planKey}`);
  const plan = planResult.rows[0];
  const templateKey = String(input.template_key || 'MODERN_COMMERCE').trim().toUpperCase();
  const templateResult = await client.query('SELECT * FROM platform_storefront_templates WHERE key=$1 AND status=\'ACTIVE\'', [templateKey]);
  if (!templateResult.rowCount) throw new Error(`Active storefront template not found: ${templateKey}`);
  const template = templateResult.rows[0];

  const tenantId = uuid(); const ownerId = uuid(); const roleId = uuid(); const storeId = uuid();
  const passwordHash = await hashPassword(password);
  const modules = { ...(plan.modules || {}), ...(input.modules || {}) };
  const limits = { ...(plan.limits || {}), ...(input.limits || {}) };
  const capabilities = { ...(plan.capabilities || {}), ...(input.capabilities || {}) };
  const branding = { store_name: name, logo_url: null, accent: template.config?.theme?.primary || null, ...(input.branding || {}) };
  const customerService = defaultSupport(Boolean(modules.luke_cs));

  const tenant = await client.query(
    `INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING id,public_id,slug,name,status`,
    [tenantId, publicId('tnt'), slug, name],
  );
  await client.query(
    `INSERT INTO tenant_settings(tenant_id,currency,locale,timezone,modules,branding,customer_service)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [tenantId, String(input.currency || 'USD').toUpperCase(), input.locale || 'en', input.timezone || 'UTC',
      JSON.stringify(modules), JSON.stringify(branding), JSON.stringify(customerService)],
  );
  await client.query(
    `INSERT INTO tenant_platform_profiles(tenant_id,plan_key,modules,limits,capabilities,notes,created_by)
     VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)`,
    [tenantId, planKey, JSON.stringify(input.modules || {}), JSON.stringify(input.limits || {}), JSON.stringify(input.capabilities || {}), input.notes || null, platformUserId],
  );
  await client.query(
    `INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,'main',$4,'ACTIVE',true)`,
    [storeId, publicId('str'), tenantId, name],
  );
  await ensureCustomerServicePolicy(client, tenantId, { enabled: Boolean(modules.luke_cs) });
  await client.query(
    `INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default)
     VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)`,
    [uuid(), publicId('loc'), tenantId, storeId],
  );
  await ensureStoreCommerceDefaults(client, { tenantId, storeId });
  await client.query(
    `INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status)
     VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')`,
    [ownerId, publicId('musr'), tenantId, email, passwordHash, input.owner_name || 'Owner'],
  );
  await client.query(`INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)`, [roleId, tenantId]);
  for (const permission of ALL_PERMISSIONS) {
    await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [roleId, permission]);
  }
  await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)', [tenantId, ownerId, roleId]);

  const experience = structuredClone(template.config || {});
  experience.branding = { ...(experience.branding || {}), store_name: name, ...(input.experience_branding || {}) };
  const normalizedExperience = normalizeExperienceConfig(experience);
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version,published_at)
     VALUES($1,$2,$3,$4,1,'PUBLISHED',$5::jsonb,$6,2,now())`,
    [uuid(), publicId('sfx'), tenantId, storeId, JSON.stringify(normalizedExperience), templateKey],
  );
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version)
     VALUES($1,$2,$3,$4,2,'DRAFT',$5::jsonb,$6,2)`,
    [uuid(), publicId('sfx'), tenantId, storeId, JSON.stringify(normalizedExperience), templateKey],
  );

  return { tenant: tenant.rows[0], owner: { email, display_name: input.owner_name || 'Owner' }, store_id: storeId,
    plan_key: planKey, template_key: templateKey, effective: { modules, limits, capabilities } };
}
