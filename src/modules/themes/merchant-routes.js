import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { applyExperienceThemePackage } from '../customer-experience/service.js';
import { listThemePackages, normalizeThemeComponentOverrides } from './service.js';
import { getStaffThemeSelection, normalizeThemeSelection, setStaffThemeSelection } from './selection-service.js';

const storeHeader = (request) => request.headers['x-store-id'] || null;
const selectionSchema={anyOf:[{type:'object',additionalProperties:false,required:['key','version'],properties:{key:{type:'string',minLength:2,maxLength:80},version:{type:'string',minLength:5,maxLength:80}}},{type:'null'}]};
const componentOverridesSchema={type:'object',maxProperties:24,additionalProperties:{type:'string',minLength:1,maxLength:64}};
const NAV_ICON_OVERRIDE_KEYS=['nav_home_icon','nav_explore_icon','nav_cart_icon','nav_orders_icon','nav_profile_icon'];

async function validatePlatformNavigationIcons(db,overrides={}){
  const requested=[...new Set(NAV_ICON_OVERRIDE_KEYS.map(key=>String(overrides[key]||'').trim().toLowerCase()).filter(Boolean))];
  if(!requested.length)return;
  const result=await db.query(
    `SELECT library_icon FROM platform_icons
      WHERE status='PUBLISHED' AND library_pack='PHOSPHOR'
        AND usage_scopes @> '["NAVIGATION"]'::jsonb
        AND library_icon=ANY($1::text[])`,
    [requested],
  );
  const allowed=new Set(result.rows.map(row=>row.library_icon));
  const rejected=requested.filter(icon=>!allowed.has(icon));
  if(rejected.length)throw errors.badRequest('PLATFORM_NAV_ICON_NOT_ALLOWED',`Navigation icon is not currently approved by the Platform Icon Library: ${rejected.join(', ')}`);
}

export async function merchantThemeRoutes(app) {
  app.get('/v1/merchant/customer-experience/theme-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async () => ({ data:{ themes:await listThemePackages(app.db,{publishedOnly:true,app:'CUSTOMER_WEB'}) } }));

  app.post('/v1/merchant/customer-experience/apply-theme', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema:{body:{type:'object',additionalProperties:false,properties:{theme_package:selectionSchema,component_overrides:componentOverridesSchema}}},
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const selection = normalizeThemeSelection(request.body?.theme_package);
    const componentOverrides = normalizeThemeComponentOverrides(request.body?.component_overrides || {});
    await validatePlatformNavigationIcons(app.db,componentOverrides);
    const draft = await app.db.transaction(async (client) => {
      const saved = await applyExperienceThemePackage(client, { tenantId:request.auth.tenantId,storeId:store.id,actorId:request.auth.actorId,selection,componentOverrides });
      await writeAudit(client, { tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'customer_experience.theme.apply',targetType:'store',targetId:store.id,
        metadata:{theme_package:selection,component_overrides:componentOverrides,version:saved.version},requestIp:request.ip,requestId:request.id });
      return saved;
    });
    return { data:{ draft } };
  });

  app.get('/v1/merchant/staff-experience/theme-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async () => ({ data:{ themes:await listThemePackages(app.db,{publishedOnly:true,app:'STAFF_WEB'}) } }));

  app.get('/v1/merchant/staff-experience/runtime', {
    preHandler:[app.requireMerchantAuth],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const current = await getStaffThemeSelection(app.db,{tenantId:request.auth.tenantId,storeId:store.id});
    return { data:{ store:{id:store.public_id,slug:store.slug,name:store.name}, theme_package:current.theme, component_overrides:current.component_overrides, effective_components:current.effective_components } };
  });

  app.get('/v1/merchant/staff-experience', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    return { data:{ store:{id:store.public_id,slug:store.slug,name:store.name}, ...(await getStaffThemeSelection(app.db,{tenantId:request.auth.tenantId,storeId:store.id})) } };
  });

  app.put('/v1/merchant/staff-experience', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.TENANT_SETTINGS_WRITE)],
    schema:{body:{type:'object',additionalProperties:false,properties:{theme_package:selectionSchema,component_overrides:componentOverridesSchema}}},
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const selection = normalizeThemeSelection(request.body?.theme_package);
    const componentOverrides = normalizeThemeComponentOverrides(request.body?.component_overrides || {});
    const data = await app.db.transaction(async (client) => {
      const saved = await setStaffThemeSelection(client,{tenantId:request.auth.tenantId,storeId:store.id,actorId:request.auth.actorId,selection,componentOverrides});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,
        action:'staff_experience.theme.update',targetType:'store',targetId:store.id,metadata:{theme_package:selection,component_overrides},requestIp:request.ip,requestId:request.id});
      return saved;
    });
    return { data:{ store:{id:store.public_id,slug:store.slug,name:store.name}, ...data } };
  });
}
