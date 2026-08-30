import { errors } from '../../core/errors.js';
import { PERMISSIONS } from '../../core/permissions.js';
import { writeAudit } from '../../core/audit.js';
import { resolveStore } from '../catalog/service.js';
import { confirmPayment } from '../payments/service.js';

const storeHeader=request=>request.headers['x-store-id']||null;
const readGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.DELIVERY_READ)];
const manageGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.DELIVERY_MANAGE)];
const reconcileGuard=app=>[app.requireMerchantAuth,app.requirePermission(PERMISSIONS.DELIVERY_MANAGE),app.requirePermission(PERMISSIONS.PAYMENTS_MANAGE)];
async function merchantStore(app,request){return resolveStore(app.db,request.auth.tenantId,storeHeader(request),{requireActive:false});}

const codSelect=`SELECT c.public_id AS id,c.status,c.currency,c.expected_amount,c.collected_amount,c.collection_note,c.remittance_note,c.reconciliation_note,c.collected_at,c.remitted_at,c.reconciled_at,c.created_at,c.updated_at,
 x.public_id AS dispatch_id,x.status AS dispatch_status,d.public_id AS driver_id,d.display_name AS driver_name,
 o.public_id AS order_id,o.order_number,o.status AS order_status,o.payment_status,
 op.public_id AS payment_id,op.status AS payment_record_status,pm.name AS payment_method_name,pm.provider_type
 FROM delivery_cod_collections c
 JOIN delivery_dispatches x ON x.id=c.dispatch_id AND x.tenant_id=c.tenant_id AND x.store_id=c.store_id
 JOIN delivery_drivers d ON d.id=c.driver_id AND d.tenant_id=c.tenant_id AND d.store_id=c.store_id
 JOIN orders o ON o.id=c.order_id AND o.tenant_id=c.tenant_id AND o.store_id=c.store_id
 JOIN order_payments op ON op.id=c.payment_id AND op.tenant_id=c.tenant_id AND op.store_id=c.store_id
 JOIN payment_methods pm ON pm.id=op.payment_method_id AND pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id`;

async function collectionByRef(db,tenantId,storeId,ref,{lock=false}={}){
 const row=await db.query(`SELECT c.*,o.status AS order_status,o.order_type,op.status AS payment_record_status,pm.provider_type
   FROM delivery_cod_collections c
   JOIN orders o ON o.id=c.order_id AND o.tenant_id=c.tenant_id AND o.store_id=c.store_id
   JOIN order_payments op ON op.id=c.payment_id AND op.tenant_id=c.tenant_id AND op.store_id=c.store_id
   JOIN payment_methods pm ON pm.id=op.payment_method_id AND pm.tenant_id=op.tenant_id AND pm.store_id=op.store_id
   WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.public_id=$3${lock?' FOR UPDATE OF c,o,op':''}`,[tenantId,storeId,ref]);
 if(!row.rowCount)throw errors.notFound('COD_COLLECTION_NOT_FOUND','Cash-on-delivery collection not found');return row.rows[0];
}

export async function merchantCodRoutes(app){
 app.get('/v1/merchant/delivery/cod',{preHandler:readGuard(app),schema:{querystring:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['COLLECTED','REMITTED','RECONCILED']},limit:{type:'integer',minimum:1,maximum:200,default:100}}}}},async request=>{
  const store=await merchantStore(app,request),values=[request.auth.tenantId,store.id];let where='c.tenant_id=$1 AND c.store_id=$2';if(request.query.status){values.push(request.query.status);where+=` AND c.status=$${values.length}`;}values.push(request.query.limit||100);
  const rows=await app.db.query(`${codSelect} WHERE ${where} ORDER BY CASE c.status WHEN 'COLLECTED' THEN 0 WHEN 'REMITTED' THEN 1 ELSE 2 END,c.collected_at DESC LIMIT $${values.length}`,values);return {data:{collections:rows.rows}};
 });

 app.post('/v1/merchant/delivery/cod/:collectionId/remit',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,properties:{note:{type:'string',maxLength:1000}}}}},async request=>{
  const store=await merchantStore(app,request);
  await app.db.transaction(async client=>{
   const current=await collectionByRef(client,request.auth.tenantId,store.id,request.params.collectionId,{lock:true});if(current.provider_type!=='CASH_ON_DELIVERY')throw errors.conflict('COD_PAYMENT_METHOD_INVALID','Collection is not backed by a cash-on-delivery payment');if(current.status!=='COLLECTED')throw errors.conflict('COD_REMITTANCE_STATE_INVALID','Only collected cash can be marked remitted');
   await client.query(`UPDATE delivery_cod_collections SET status='REMITTED',remittance_note=$1,remitted_at=now(),remitted_by=$2,updated_at=now() WHERE id=$3`,[request.body?.note?.trim()||null,request.auth.actorId,current.id]);
   await client.query(`INSERT INTO delivery_cod_events(tenant_id,store_id,collection_id,event_type,actor_type,actor_id,amount,note,request_id) VALUES($1,$2,$3,'REMITTED','MERCHANT',$4,$5,$6,$7)`,[request.auth.tenantId,store.id,current.id,request.auth.actorId,current.collected_amount,request.body?.note?.trim()||null,request.id]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'delivery.cod.remit',targetType:'delivery_cod_collection',targetId:current.id,metadata:{amount:Number(current.collected_amount),currency:current.currency},requestIp:request.ip,requestId:request.id});
  });return {data:{collection:(await app.db.query(`${codSelect} WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.public_id=$3`,[request.auth.tenantId,store.id,request.params.collectionId])).rows[0]}};
 });

 app.post('/v1/merchant/delivery/cod/:collectionId/reconcile',{preHandler:reconcileGuard(app),schema:{body:{type:'object',additionalProperties:false,properties:{note:{type:'string',maxLength:1000}}}}},async request=>{
  const store=await merchantStore(app,request);
  await app.db.transaction(async client=>{
   const current=await collectionByRef(client,request.auth.tenantId,store.id,request.params.collectionId,{lock:true});if(current.provider_type!=='CASH_ON_DELIVERY')throw errors.conflict('COD_PAYMENT_METHOD_INVALID','Collection is not backed by a cash-on-delivery payment');if(current.status!=='REMITTED')throw errors.conflict('COD_RECONCILIATION_STATE_INVALID','Cash must be marked remitted before reconciliation');if(Number(current.collected_amount)!==Number(current.expected_amount))throw errors.conflict('COD_AMOUNT_MISMATCH','Collected cash does not match the expected payment amount');
   if(current.payment_record_status!=='PAID'){
    const order=(await client.query(`SELECT * FROM orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[request.auth.tenantId,store.id,current.order_id])).rows[0];if(!order)throw errors.notFound('ORDER_NOT_FOUND','Order not found');
    await confirmPayment(client,{tenantId:request.auth.tenantId,storeId:store.id,order,providerReference:`COD:${current.public_id}`,requestId:request.id});
   }
   await client.query(`UPDATE delivery_cod_collections SET status='RECONCILED',reconciliation_note=$1,reconciled_at=now(),reconciled_by=$2,updated_at=now() WHERE id=$3`,[request.body?.note?.trim()||null,request.auth.actorId,current.id]);
   await client.query(`INSERT INTO delivery_cod_events(tenant_id,store_id,collection_id,event_type,actor_type,actor_id,amount,note,request_id) VALUES($1,$2,$3,'RECONCILED','MERCHANT',$4,$5,$6,$7)`,[request.auth.tenantId,store.id,current.id,request.auth.actorId,current.collected_amount,request.body?.note?.trim()||null,request.id]);
   await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'delivery.cod.reconcile',targetType:'delivery_cod_collection',targetId:current.id,metadata:{amount:Number(current.collected_amount),currency:current.currency,payment_was_already_paid:current.payment_record_status==='PAID'},requestIp:request.ip,requestId:request.id});
  });return {data:{collection:(await app.db.query(`${codSelect} WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.public_id=$3`,[request.auth.tenantId,store.id,request.params.collectionId])).rows[0]}};
 });
}
