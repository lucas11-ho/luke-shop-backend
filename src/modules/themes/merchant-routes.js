import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { applyExperienceThemePackage } from '../customer-experience/service.js';
import { listPlatformIcons } from '../icons/service.js';
import { listThemePackages, normalizeThemeComponentOverrides } from './service.js';
import { validateCustomerNavigationIconPolicy } from './customer-icon-policy.js';
import { getStaffThemeSelection, normalizeThemeSelection, setStaffThemeSelection } from './selection-service.js';

const storeHeader = (request) => request.headers['x-store-id'] || null;
const selectionSchema={anyOf:[{type:'object',additionalProperties:false,required:['key','version'],properties:{key:{type:'string',minLength:2,maxLength:80},version:{type:'string',minLength:5,maxLength:80}}},{type:'null'}]};
const componentOverridesSchema={type:'object',maxProperties:24,additionalProperties:{type:'string',minLength:1,maxLength:64}};

export async function merchantThemeRoutes(app) {
  app.get('/v1/merchant/customer-experience/theme-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async () => ({ data:{ themes:await listThemePackages(app.db,{publishedOnly:true,app:'CUSTOMER_WEB'}) } }));

  app.get('/v1/merchant/customer-experience/icon-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async () => ({ data:{ icons:await listPlatformIcons(app.db,{status:'PUBLISHED',scope:'NAVIGATION'}) } }));

  app.post('/v1/merchant/customer-experience/apply-theme', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_MANAGE)],
    schema:{body:{type:'object',additionalProperties:false,properties:{theme_package:selectionSchema,component_overrides:componentOverridesSchema}}},
  }, async (request) => {
    const store = await resolveStore(app.db, request.auth.tenantId, storeHeader(request));
    const selection = normalizeThemeSelection(request.body?.theme_package);
    const componentOverrides = normalizeThemeComponentOverrides(request.body?.component_overrides || {});
    const draft = await app.db.transaction(async (client) => {
      await validateCustomerNavigationIconPolicy(client,componentOverrides,{strict:true});
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
