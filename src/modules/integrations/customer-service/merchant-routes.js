import { errors } from '../../../core/errors.js';
import { PERMISSIONS } from '../../../core/permissions.js';
import { newServiceCredential } from '../../../core/tokens.js';
import { publicId, uuid } from '../../../core/identifiers.js';
import { writeAudit } from '../../../core/audit.js';
import { getCustomerServicePolicy } from './policy.js';

const ALLOWED_SCOPES=new Set(['customer.read','product.read','orders.read','order_status.read','payments.read','delivery.read']);
const USAGE_MODES=new Set(['STAFF','AI']);

function publicPolicy(row){return { enabled:row.enabled,access:{customer:row.customer_read,product:row.product_read,orders:row.orders_read,payments:row.payments_read,delivery:row.delivery_read},ai_access:{customer:row.ai_customer_read,product:row.ai_product_read,orders:row.ai_orders_read,payments:row.ai_payments_read,delivery:row.ai_delivery_read},context_ttl_seconds:row.context_ttl_seconds,tool_rate_limit_per_minute:row.tool_rate_limit_per_minute,updated_at:row.updated_at};}

export async function customerServiceMerchantRoutes(app) {
  app.get('/v1/merchant/integrations/customer-service',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CS_INTEGRATION_READ)]},async(request)=>{
    const result=await app.db.query(`SELECT public_id,name,client_id,scopes,usage_mode,status,created_at,last_used_at,revoked_at FROM integration_clients WHERE tenant_id=$1 AND kind='LUKE_CS' ORDER BY created_at DESC`,[request.auth.tenantId]);
    return {data:{clients:result.rows}};
  });

  app.get('/v1/merchant/integrations/customer-service/policy',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CS_INTEGRATION_READ)]},async(request)=>{
    const policy=await getCustomerServicePolicy(app.db,request.auth.tenantId); return {data:{policy:publicPolicy(policy)}};
  });

  app.patch('/v1/merchant/integrations/customer-service/policy',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CS_INTEGRATION_MANAGE)],schema:{body:{type:'object',additionalProperties:false,properties:{
    enabled:{type:'boolean'},access:{type:'object',additionalProperties:false,properties:{customer:{type:'boolean'},product:{type:'boolean'},orders:{type:'boolean'},payments:{type:'boolean'},delivery:{type:'boolean'}}},
    ai_access:{type:'object',additionalProperties:false,properties:{customer:{type:'boolean'},product:{type:'boolean'},orders:{type:'boolean'},payments:{type:'boolean'},delivery:{type:'boolean'}}},
    context_ttl_seconds:{type:'integer',minimum:60,maximum:900},tool_rate_limit_per_minute:{type:'integer',minimum:1,maximum:600},
  }}}},async(request)=>{
    const b=request.body||{}; const current=await getCustomerServicePolicy(app.db,request.auth.tenantId); if(!current) throw errors.notFound('CS_POLICY_NOT_FOUND','Customer service policy not found');
    const a=b.access||{},ai=b.ai_access||{};
    const values=[b.enabled??current.enabled,a.customer??current.customer_read,a.product??current.product_read,a.orders??current.orders_read,a.payments??current.payments_read,a.delivery??current.delivery_read,ai.customer??current.ai_customer_read,ai.product??current.ai_product_read,ai.orders??current.ai_orders_read,ai.payments??current.ai_payments_read,ai.delivery??current.ai_delivery_read,b.context_ttl_seconds??current.context_ttl_seconds,b.tool_rate_limit_per_minute??current.tool_rate_limit_per_minute,request.auth.actorId,request.auth.tenantId];
    const updated=await app.db.transaction(async(client)=>{const r=await client.query(`UPDATE customer_service_policies SET enabled=$1,customer_read=$2,product_read=$3,orders_read=$4,payments_read=$5,delivery_read=$6,ai_customer_read=$7,ai_product_read=$8,ai_orders_read=$9,ai_payments_read=$10,ai_delivery_read=$11,context_ttl_seconds=$12,tool_rate_limit_per_minute=$13,updated_by=$14,updated_at=now() WHERE tenant_id=$15 RETURNING *`,values); await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'integration.customer_service.policy.update',targetType:'tenant',targetId:request.auth.tenantId,metadata:{changed_fields:Object.keys(b)},requestIp:request.ip,requestId:request.id}); return r.rows[0];});
    return {data:{policy:publicPolicy(updated)}};
  });

  app.post('/v1/merchant/integrations/customer-service/credentials',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CS_INTEGRATION_MANAGE)],schema:{body:{type:'object',additionalProperties:false,required:['name','scopes'],properties:{name:{type:'string',minLength:1,maxLength:100},scopes:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',maxLength:100}},usage_mode:{type:'string',enum:['STAFF','AI'],default:'STAFF'}}}}},async(request,reply)=>{
    for(const scope of request.body.scopes) if(!ALLOWED_SCOPES.has(scope)) throw errors.badRequest('SERVICE_SCOPE_INVALID',`Scope is not available for Luke CS integration: ${scope}`);
    const usageMode=request.body.usage_mode||'STAFF'; if(!USAGE_MODES.has(usageMode)) throw errors.badRequest('SERVICE_USAGE_MODE_INVALID','Invalid service credential usage mode');
    const credential=newServiceCredential(app.config.serviceCredentialPepper); const id=uuid(); const publicID=publicId('int');
    await app.db.transaction(async(client)=>{await client.query(`INSERT INTO integration_clients(id,public_id,tenant_id,kind,name,client_id,secret_hash,scopes,usage_mode,status) VALUES($1,$2,$3,'LUKE_CS',$4,$5,$6,$7,$8,'ACTIVE')`,[id,publicID,request.auth.tenantId,request.body.name.trim(),credential.clientId,credential.secretHash,request.body.scopes,usageMode]); await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'integration.customer_service.credential.create',targetType:'integration_client',targetId:id,metadata:{public_id:publicID,scopes:request.body.scopes,usage_mode:usageMode},requestIp:request.ip,requestId:request.id});});
    return reply.code(201).send({data:{client:{id:publicID,name:request.body.name.trim(),client_id:credential.clientId,scopes:request.body.scopes,usage_mode:usageMode,status:'ACTIVE'},secret:credential.secret,credential:`${credential.clientId}.${credential.secret}`,warning:'The secret is returned once. Store it securely; it cannot be recovered later.'}});
  });

  app.post('/v1/merchant/integrations/customer-service/:clientId/revoke',{preHandler:[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.CS_INTEGRATION_MANAGE)]},async(request)=>{const result=await app.db.transaction(async(client)=>{const changed=await client.query(`UPDATE integration_clients SET status='REVOKED',revoked_at=now() WHERE tenant_id=$1 AND public_id=$2 AND kind='LUKE_CS' AND status='ACTIVE' RETURNING id,public_id`,[request.auth.tenantId,request.params.clientId]); if(!changed.rowCount) throw errors.notFound('INTEGRATION_CLIENT_NOT_FOUND','Active integration credential not found'); await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'integration.customer_service.credential.revoke',targetType:'integration_client',targetId:changed.rows[0].id,requestIp:request.ip,requestId:request.id}); return changed.rows[0];}); return {data:{client:{id:result.public_id,status:'REVOKED'}}};});
}
