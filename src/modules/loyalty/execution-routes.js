import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { adjustVipReward, expireDueVipEntitlements, expireDueVipRewards, vipExecutionSummary, vipRewardAccount } from './execution.js';
import { vipCashbackRedemptionPolicy } from './redemption.js';
import { issueManualVipEntitlement, recurringVipIssuancePolicy, runRecurringVipEntitlements } from './issuance.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const readGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.LOYALTY_READ)];
const manageGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.LOYALTY_MANAGE)];
async function merchantStore(app,request){return resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});}
async function customerByRef(db,tenantId,ref){const result=await db.query(`SELECT id,public_id,customer_code,display_name FROM customers WHERE tenant_id=$1 AND (public_id=$2 OR customer_code=$2)`,[tenantId,ref]);if(!result.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');return result.rows[0];}

export async function loyaltyExecutionRoutes(app){
  app.get('/v1/merchant/vip/execution',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request);const summary=await app.db.transaction(client=>vipExecutionSummary(client,{tenantId:request.auth.tenantId,storeId:store.id}));
    return {data:{store:{id:store.public_id,name:store.name},execution:summary}};
  });

  app.put('/v1/merchant/vip/execution-policy',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['upgrade_policy'],properties:{upgrade_policy:{type:'string',enum:['IMMEDIATE','SCHEDULED','MANUAL']}}}}},async request=>{
    const store=await merchantStore(app,request);let policy;
    await app.db.transaction(async client=>{
      const result=await client.query(`UPDATE vip_programs SET upgrade_policy=$1,updated_at=now() WHERE tenant_id=$2 AND store_id=$3 RETURNING enabled,upgrade_policy`,[request.body.upgrade_policy,request.auth.tenantId,store.id]);
      if(!result.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');policy=result.rows[0];
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.execution_policy.update',targetType:'vip_program',targetId:store.id,metadata:{upgrade_policy:request.body.upgrade_policy},requestIp:request.ip,requestId:request.id});
    });
    return {data:{policy}};
  });

  app.get('/v1/merchant/vip/redemption-policy',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request);const policy=await vipCashbackRedemptionPolicy(app.db,{tenantId:request.auth.tenantId,storeId:store.id});
    return {data:{store:{id:store.public_id,name:store.name},policy}};
  });

  app.put('/v1/merchant/vip/redemption-policy',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['cashback_redemption_enabled','max_percent','min_amount'],properties:{cashback_redemption_enabled:{type:'boolean'},max_percent:{type:'number',minimum:0,maximum:100},min_amount:{type:'number',minimum:0,maximum:1000000}}}}},async request=>{
    const store=await merchantStore(app,request);let policy;
    await app.db.transaction(async client=>{
      const result=await client.query(`UPDATE vip_programs SET cashback_redemption_enabled=$1,cashback_redemption_max_percent=$2,cashback_redemption_min_amount=$3,updated_at=now() WHERE tenant_id=$4 AND store_id=$5 RETURNING id`,[request.body.cashback_redemption_enabled,request.body.max_percent,request.body.min_amount,request.auth.tenantId,store.id]);
      if(!result.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');
      policy=await vipCashbackRedemptionPolicy(client,{tenantId:request.auth.tenantId,storeId:store.id});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.redemption_policy.update',targetType:'vip_program',targetId:store.id,metadata:{cashback_redemption_enabled:request.body.cashback_redemption_enabled,max_percent:Number(request.body.max_percent),min_amount:Number(request.body.min_amount)},requestIp:request.ip,requestId:request.id});
    });
    return {data:{policy}};
  });

  app.get('/v1/merchant/vip/issuance-policy',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request),policy=await recurringVipIssuancePolicy(app.db,{tenantId:request.auth.tenantId,storeId:store.id});
    return {data:{store:{id:store.public_id,name:store.name},policy}};
  });

  app.put('/v1/merchant/vip/issuance-policy',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['recurring_entitlement_issuance_enabled'],properties:{recurring_entitlement_issuance_enabled:{type:'boolean'}}}}},async request=>{
    const store=await merchantStore(app,request),tenantId=request.auth.tenantId,enabled=request.body.recurring_entitlement_issuance_enabled;let policy;
    await app.db.transaction(async client=>{
      const current=await client.query(`SELECT id,recurring_entitlement_issuance_enabled FROM vip_programs WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE`,[tenantId,store.id]);
      if(!current.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');
      const was=!!current.rows[0].recurring_entitlement_issuance_enabled;
      await client.query(`UPDATE vip_programs SET recurring_entitlement_issuance_enabled=$1,recurring_entitlement_issuance_enabled_at=CASE WHEN $1=true AND $2=false THEN now() WHEN $1=true THEN recurring_entitlement_issuance_enabled_at ELSE NULL END,updated_at=now() WHERE tenant_id=$3 AND store_id=$4`,[enabled,was,tenantId,store.id]);
      policy=await recurringVipIssuancePolicy(client,{tenantId,storeId:store.id});
      await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.recurring_entitlements.policy.update',targetType:'vip_program',targetId:current.rows[0].id,metadata:{recurring_entitlement_issuance_enabled:enabled,effective:policy.enabled},requestIp:request.ip,requestId:request.id});
    });
    return {data:{policy}};
  });

  app.post('/v1/merchant/vip/issuance/run',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:5000}}}}},async request=>{
    const store=await merchantStore(app,request),tenantId=request.auth.tenantId;let summary;
    await app.db.transaction(async client=>{
      summary=await runRecurringVipEntitlements(client,{tenantId,storeId:store.id,limit:request.body?.limit||5000});
      await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.recurring_entitlements.run',targetType:'store',targetId:store.id,metadata:summary,requestIp:request.ip,requestId:request.id});
    });
    return {data:{summary}};
  });

  app.post('/v1/merchant/vip/members/:customerRef/entitlements/issue',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['benefit_id','request_key','reason'],properties:{benefit_id:{type:'string',minLength:1,maxLength:120},request_key:{type:'string',minLength:8,maxLength:120},reason:{type:'string',minLength:3,maxLength:1000}}}}},async request=>{
    const store=await merchantStore(app,request),tenantId=request.auth.tenantId,customer=await customerByRef(app.db,tenantId,request.params.customerRef);let result;
    await app.db.transaction(async client=>{
      result=await issueManualVipEntitlement(client,{tenantId,storeId:store.id,customerId:customer.id,benefitRef:request.body.benefit_id,requestKey:request.body.request_key,reason:request.body.reason});
      await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.manual_entitlement.issue',targetType:'customer',targetId:customer.id,metadata:{benefit_id:request.body.benefit_id,request_key:request.body.request_key,reason:request.body.reason,created:result.created},requestIp:request.ip,requestId:request.id});
    });
    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},...result}};
  });

  app.get('/v1/merchant/vip/members/:customerRef/rewards',{preHandler:readGuard(app)},async request=>{
    const store=await merchantStore(app,request),customer=await customerByRef(app.db,request.auth.tenantId,request.params.customerRef);
    const rewards=await app.db.transaction(client=>vipRewardAccount(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:customer.id}));
    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},rewards}};
  });

  app.post('/v1/merchant/vip/members/:customerRef/rewards/adjust',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['amount','reason'],properties:{amount:{type:'number',minimum:-1000000,maximum:1000000},reason:{type:'string',minLength:3,maxLength:1000},expires_at:{type:['string','null'],format:'date-time'}}}}},async request=>{
    const store=await merchantStore(app,request),customer=await customerByRef(app.db,request.auth.tenantId,request.params.customerRef);let rewards;
    await app.db.transaction(async client=>{
      rewards=await adjustVipReward(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:customer.id,amount:request.body.amount,reason:request.body.reason.trim(),expiresAt:request.body.expires_at?new Date(request.body.expires_at):null,actorId:request.auth.actorId});
      await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.reward.adjust',targetType:'customer',targetId:customer.id,metadata:{amount:Number(request.body.amount),reason:request.body.reason.trim(),expires_at:request.body.expires_at||null},requestIp:request.ip,requestId:request.id});
    });
    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},rewards}};
  });

  app.post('/v1/merchant/vip/rewards/expire',{preHandler:manageGuard(app)},async request=>{
    const store=await merchantStore(app,request);let rewards=0,entitlements=0;
    await app.db.transaction(async client=>{rewards=await expireDueVipRewards(client,{tenantId:request.auth.tenantId,storeId:store.id});entitlements=await expireDueVipEntitlements(client,{tenantId:request.auth.tenantId,storeId:store.id});});
    return {data:{expired_rewards:rewards,expired_entitlements:entitlements}};
  });

  app.get('/v1/customer/vip/rewards',{preHandler:[app.requireCustomerAuth]},async request=>{
    const store=await resolveStore(app.db,request.auth.tenantId,storeHeader(request));
    const result=await app.db.transaction(async client=>({rewards:await vipRewardAccount(client,{tenantId:request.auth.tenantId,storeId:store.id,customerId:request.auth.actorId,ledgerLimit:50}),redemption_policy:await vipCashbackRedemptionPolicy(client,{tenantId:request.auth.tenantId,storeId:store.id})}));
    return {data:result};
  });
}
