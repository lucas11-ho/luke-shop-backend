import { resolveStore } from '../catalog/service.js';
import { vipMemberDetail } from './service.js';

const storeHeader=request=>request.headers['x-store-id']||null;

export async function customerLoyaltyRoutes(app){
  app.get('/v1/customer/vip',{preHandler:[app.requireCustomerAuth]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
    const customer=await app.db.query('SELECT public_id FROM customers WHERE tenant_id=$1 AND id=$2',[request.auth.tenantId,request.auth.actorId]);
    if(!customer.rowCount)return {data:{vip:null}};
    const detail=await vipMemberDetail(app.db,{tenantId:request.auth.tenantId,storeId:store.id,customerRef:customer.rows[0].public_id});
    return {data:{vip:{
      enabled:Boolean(detail.program?.enabled),
      currency:detail.program?.currency||store.currency,
      evaluation_period:detail.program?.evaluation_period||'LIFETIME',
      evaluation_start:detail.live_metrics?.evaluation_start||null,
      evaluation_end:detail.live_metrics?.evaluation_end||null,
      current_level:detail.current_level?{id:detail.current_level.id,code:detail.current_level.code,name:detail.current_level.name,badge_icon:detail.current_level.badge_icon,badge_color:detail.current_level.badge_color,sort_order:detail.current_level.sort_order}:null,
      next_level:detail.next_level?{id:detail.next_level.id,code:detail.next_level.code,name:detail.next_level.name,badge_icon:detail.next_level.badge_icon,badge_color:detail.next_level.badge_color,sort_order:detail.next_level.sort_order,qualification_mode:detail.next_level.qualification_mode,spend_threshold:detail.next_level.spend_threshold,order_threshold:detail.next_level.order_threshold}:null,
      progress:{qualified_spend:detail.live_metrics?.qualified_spend||0,qualified_orders:detail.live_metrics?.qualified_orders||0},
      tier_expires_at:detail.status?.tier_expires_at||null,
      grace_until:detail.status?.grace_until||null,
      benefits:(detail.benefits||[]).map(b=>({id:b.id,name:b.name,benefit_type:b.benefit_type,frequency:b.frequency,config:b.config})),
      history:(detail.history||[]).slice(0,25).map(h=>({source:h.source,reason:h.reason,from_level_id:h.from_level_id,from_level_name:h.from_level_name,to_level_id:h.to_level_id,to_level_name:h.to_level_name,created_at:h.created_at})),
    }}};
  });
}
