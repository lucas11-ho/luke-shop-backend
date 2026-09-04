import { PERMISSIONS } from '../../core/permissions.js';
import { resolveStore } from '../catalog/service.js';
import { getVipAnalytics } from './analytics.js';

const storeHeader=request=>request.headers['x-store-id']||null;

export async function loyaltyAnalyticsRoutes(app){
  app.get('/v1/merchant/vip/analytics',{
    preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.LOYALTY_READ)],
    schema:{querystring:{type:'object',additionalProperties:false,properties:{days:{type:'integer',enum:[7,30,90,365]}}}},
  },async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});
    return {data:await getVipAnalytics(app.db,{tenantId:request.auth.tenantId,storeId:store.id,days:request.query?.days||30})};
  });
}
