import { PERMISSIONS } from '../../core/permissions.js';
import { listThemePackages } from './service.js';

export async function merchantThemeRoutes(app) {
  app.get('/v1/merchant/customer-experience/theme-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CUSTOMER_EXPERIENCE_READ)],
  }, async () => ({ data:{ themes:await listThemePackages(app.db,{publishedOnly:true,app:'CUSTOMER_WEB'}) } }));

  app.get('/v1/merchant/staff-experience/theme-catalog', {
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.TENANT_SETTINGS_READ)],
  }, async () => ({ data:{ themes:await listThemePackages(app.db,{publishedOnly:true,app:'STAFF_WEB'}) } }));
}
