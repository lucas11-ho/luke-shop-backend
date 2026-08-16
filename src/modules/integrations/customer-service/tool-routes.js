import { errors } from '../../../core/errors.js';
import { publicId } from '../../../core/identifiers.js';
import { productDetails } from '../../catalog/service.js';
import { orderDetails } from '../../orders/service.js';
import { paymentDetails } from '../../payments/service.js';
import { fulfillmentDetails } from '../../delivery/service.js';
import { getCustomerServicePolicy, isToolAllowed, toolPolicy, CS_TOOL_NAMES } from './policy.js';

function integer(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw errors.badRequest('TOOL_ARGUMENT_INVALID', 'Invalid tool argument');
  return parsed;
}

function text(value, name, max = 200) {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw errors.badRequest('TOOL_ARGUMENT_INVALID', `${name} is required`);
  return result;
}

async function customerRow(app, request) {
  const result = await app.db.query(
    `SELECT public_id,customer_code,display_name,status,created_at
       FROM customers WHERE tenant_id=$1 AND id=$2`,
    [request.serviceAuth.tenantId, request.supportContext.customer_id],
  );
  if (!result.rowCount) throw errors.notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
  return result.rows[0];
}


async function assertOrderInContext(app, request, orderRef) {
  const found = await app.db.query(
    `SELECT id FROM orders WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND (public_id=$4 OR order_number=$4) LIMIT 1`,
    [request.serviceAuth.tenantId, request.supportContext.store_id, request.supportContext.customer_id, orderRef],
  );
  if (!found.rowCount) throw errors.notFound('ORDER_NOT_FOUND', 'Order not found');
}

async function executeTool(app, request, tool, args) {
  const tenantId = request.serviceAuth.tenantId;
  const storeId = request.supportContext.store_id;
  const customerId = request.supportContext.customer_id;
  switch (tool) {
    case 'customer.get':
      return { targetType: 'customer', targetRef: request.supportContext.customer_public_id, result: await customerRow(app, request) };
    case 'product.search': { const q=text(args.q,'q'); const limit=integer(args.limit,10,1,20);
      const rows=await app.db.query(`SELECT p.public_id AS id,p.slug,p.name,p.short_description,p.product_type,p.base_price,p.currency,
        (SELECT m.url FROM product_media m WHERE m.tenant_id=p.tenant_id AND m.store_id=p.store_id AND m.product_id=p.id AND m.visibility='PUBLIC' AND m.status='ACTIVE' ORDER BY m.is_primary DESC,m.sort_order,m.created_at LIMIT 1) AS primary_media_url
        FROM products p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.status='PUBLISHED' AND (p.name ILIKE '%'||$3||'%' OR p.slug ILIKE '%'||$3||'%' OR COALESCE(p.short_description,'') ILIKE '%'||$3||'%')
        ORDER BY CASE WHEN lower(p.name)=lower($3) THEN 0 ELSE 1 END,p.name LIMIT $4`,[tenantId,storeId,q,limit]);
      return { targetType:'product',targetRef:q,result:{products:rows.rows} }; }
    case 'product.get': { const ref=text(args.product_ref,'product_ref',160); const found=await app.db.query(`SELECT id FROM products WHERE tenant_id=$1 AND store_id=$2 AND status='PUBLISHED' AND (public_id=$3 OR slug=$3) LIMIT 1`,[tenantId,storeId,ref]);
      if(!found.rowCount) throw errors.notFound('PRODUCT_NOT_FOUND','Product not found');
      return { targetType:'product',targetRef:ref,result:await productDetails(app.db,tenantId,storeId,found.rows[0].id,{publicOnly:true}) }; }
    case 'orders.list': { const limit=integer(args.limit,10,1,50); const rows=await app.db.query(`SELECT o.public_id AS id,o.order_number,o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at,o.updated_at FROM orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.customer_id=$3 ORDER BY o.created_at DESC LIMIT $4`,[tenantId,storeId,customerId,limit]);
      return { targetType:'customer',targetRef:request.supportContext.customer_public_id,result:{orders:rows.rows} }; }
    case 'order.get': { const ref=text(args.order_ref,'order_ref',160); await assertOrderInContext(app,request,ref); return { targetType:'order',targetRef:ref,result:await orderDetails(app.db,tenantId,ref,{customerId,publicSafe:true}) }; }
    case 'order.status': { const ref=text(args.order_ref,'order_ref',160); const rows=await app.db.query(`SELECT o.public_id AS id,o.order_number,o.order_type,o.status,o.payment_status,o.currency,o.grand_total,o.created_at,o.updated_at,o.paid_at,o.cancelled_at,o.completed_at FROM orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.customer_id=$3 AND (o.public_id=$4 OR o.order_number=$4) LIMIT 1`,[tenantId,storeId,customerId,ref]);
      if(!rows.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');
      const fulfillments=await fulfillmentDetails(app.db,tenantId,ref,{customerId});
      return { targetType:'order',targetRef:ref,result:{...rows.rows[0],fulfillments:fulfillments.map(row=>({id:row.id,fulfillment_type:row.fulfillment_type,fulfillment_mode:row.fulfillment_mode,status:row.status,workflow:row.workflow,estimated_ready_at:row.estimated_ready_at,estimated_delivery_at:row.estimated_delivery_at,tracking_number:row.tracking_number,carrier:row.carrier,items:row.items}))} }; }
    case 'payment.status': { const ref=text(args.order_ref,'order_ref',160); await assertOrderInContext(app,request,ref); const payment=await paymentDetails(app.db,tenantId,ref,{customerId}); return { targetType:'order',targetRef:ref,result:{ id:payment.id,status:payment.status,amount:payment.amount,currency:payment.currency,payment_method:{id:payment.payment_method_id,code:payment.payment_method_code,name:payment.payment_method_name,type:payment.provider_type},paid_at:payment.paid_at,failed_at:payment.failed_at,cancelled_at:payment.cancelled_at,refunded_amount:payment.refunded_amount } }; }
    case 'delivery.status': { const ref=text(args.order_ref,'order_ref',160); await assertOrderInContext(app,request,ref); const rows=await fulfillmentDetails(app.db,tenantId,ref,{customerId}); const safe=rows.map((row)=>({ id:row.id,fulfillment_type:row.fulfillment_type,fulfillment_mode:row.fulfillment_mode,status:row.status,workflow:row.workflow,allowed_transitions:row.allowed_transitions,carrier:row.carrier,tracking_number:row.tracking_number,estimated_at:row.estimated_at,estimated_ready_at:row.estimated_ready_at,estimated_delivery_at:row.estimated_delivery_at,shipped_at:row.shipped_at,delivered_at:row.delivered_at,items:row.items,delivery_method:{id:row.delivery_method_id,code:row.delivery_method_code,name:row.delivery_method_name} })); return { targetType:'order',targetRef:ref,result:{fulfillments:safe} }; }
    default: throw errors.badRequest('CS_TOOL_UNKNOWN','Unknown customer service tool');
  }
}

async function writeToolCall(app, request, { tool, targetType=null, targetRef=null, resultCode, durationMs }) {
  await app.db.query(`INSERT INTO customer_service_tool_calls(public_id,tenant_id,integration_client_id,context_id,customer_id,tool_name,target_type,target_ref,result_code,duration_ms,request_id,request_nonce_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[publicId('tcall'),request.serviceAuth.tenantId,request.serviceAuth.clientId,request.supportContext?.id||null,request.supportContext?.customer_id||null,tool,targetType,targetRef,resultCode,Math.max(0,Math.round(durationMs)),request.id,request.serviceRequest?.nonceHash||null]);
}

export async function customerServiceToolRoutes(app) {
  app.post('/v1/customer-service/tools/execute', {
    preHandler: [app.requireCustomerServiceAuth, app.requireSignedCustomerServiceToken, app.requireFreshCustomerServiceRequest, app.requireCustomerServiceContext],
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
    schema: { body: { type:'object',additionalProperties:false,required:['tool'],properties:{
      tool:{type:'string',enum:CS_TOOL_NAMES},arguments:{type:'object',default:{}},
    } } },
  }, async (request) => {
    const started=Date.now(); const tool=request.body.tool; const args=request.body.arguments||{}; let targetType=null; let targetRef=null;
    try {
      const policy=await getCustomerServicePolicy(app.db,request.serviceAuth.tenantId);
      const rule=toolPolicy(tool);
      if(!rule) throw errors.badRequest('CS_TOOL_UNKNOWN','Unknown customer service tool');
      if(!request.serviceAuth.scopes.includes(rule.scope)) throw errors.forbidden('SERVICE_SCOPE_REQUIRED',`Missing service scope: ${rule.scope}`);
      if(!request.supportContext.allowed_tools?.includes(tool)) throw errors.forbidden('SUPPORT_CONTEXT_TOOL_DENIED','Tool is outside the signed customer context');
      if(!isToolAllowed(policy,request.serviceAuth.usageMode,tool)) throw errors.forbidden('CS_TOOL_POLICY_DENIED','Tenant policy does not allow this tool');
      const used=await app.db.query(`SELECT count(*)::int AS count FROM customer_service_tool_calls WHERE tenant_id=$1 AND integration_client_id=$2 AND created_at>now()-interval '1 minute'`,[request.serviceAuth.tenantId,request.serviceAuth.clientId]);
      if(Number(used.rows[0].count)>=Number(policy.tool_rate_limit_per_minute)) throw errors.rateLimited('CS_TOOL_RATE_LIMITED','Tenant customer service tool limit reached');
      const executed=await executeTool(app,request,tool,args); targetType=executed.targetType; targetRef=executed.targetRef;
      await writeToolCall(app,request,{tool,targetType,targetRef,resultCode:'SUCCESS',durationMs:Date.now()-started});
      return { data:{ tool,result:executed.result },meta:{ source:'LUKE_SHOP',request_id:request.id,tenant_id:request.serviceAuth.tenantPublicId,customer_id:request.supportContext.customer_public_id,store_id:request.supportContext.store_public_id } };
    } catch(error) {
      await writeToolCall(app,request,{tool,targetType,targetRef,resultCode:error?.code||'INTERNAL_ERROR',durationMs:Date.now()-started});
      throw error;
    }
  });
}
