import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { money } from '../orders/service.js';

const PHYSICAL_MODES=new Set(['SHIPPING','LOCAL_DELIVERY','PICKUP']);
const WORKFLOWS={
 PHYSICAL_SHIPPING:{label:'Physical shipping',transitions:{PENDING:['PREPARING','CANCELLED','FAILED'],PREPARING:['READY','SHIPPED','CANCELLED','FAILED'],READY:['SHIPPED','CANCELLED','FAILED'],SHIPPED:['OUT_FOR_DELIVERY','DELIVERED','FAILED'],OUT_FOR_DELIVERY:['DELIVERED','FAILED'],DELIVERED:['COMPLETED'],COMPLETED:[]}},
 PHYSICAL_LOCAL_DELIVERY:{label:'Local delivery',transitions:{PENDING:['PREPARING','CANCELLED','FAILED'],PREPARING:['READY','CANCELLED','FAILED'],READY:['OUT_FOR_DELIVERY','DELIVERED','CANCELLED','FAILED'],OUT_FOR_DELIVERY:['DELIVERED','FAILED'],DELIVERED:['COMPLETED'],COMPLETED:[]}},
 PHYSICAL_PICKUP:{label:'Store pickup',transitions:{PENDING:['PREPARING','CANCELLED','FAILED'],PREPARING:['READY','CANCELLED','FAILED'],READY:['PICKED_UP','CANCELLED','FAILED'],PICKED_UP:['COMPLETED'],COMPLETED:[]}},
 FOOD_DELIVERY:{label:'Food delivery',transitions:{PENDING:['PREPARING','CANCELLED','FAILED'],PREPARING:['READY','CANCELLED','FAILED'],READY:['OUT_FOR_DELIVERY','DELIVERED','CANCELLED','FAILED'],OUT_FOR_DELIVERY:['DELIVERED','FAILED'],DELIVERED:['COMPLETED'],COMPLETED:[]}},
 FOOD_PICKUP:{label:'Food pickup',transitions:{PENDING:['PREPARING','CANCELLED','FAILED'],PREPARING:['READY','CANCELLED','FAILED'],READY:['PICKED_UP','CANCELLED','FAILED'],PICKED_UP:['COMPLETED'],COMPLETED:[]}},
 DIGITAL_DOWNLOAD:{label:'Digital download',transitions:{PENDING:['PROCESSING','AVAILABLE_FOR_DOWNLOAD','CANCELLED','FAILED'],PROCESSING:['AVAILABLE_FOR_DOWNLOAD','FAILED'],AVAILABLE_FOR_DOWNLOAD:['COMPLETED'],COMPLETED:[]}},
 DIGITAL_ACCESS:{label:'Digital access',transitions:{PENDING:['PROCESSING','ACCESS_GRANTED','CANCELLED','FAILED'],PROCESSING:['ACCESS_GRANTED','FAILED'],ACCESS_GRANTED:['COMPLETED'],COMPLETED:[]}},
 SERVICE:{label:'Service',transitions:{PENDING:['PROCESSING','CANCELLED','FAILED'],PROCESSING:['READY','COMPLETED','FAILED'],READY:['COMPLETED','FAILED'],COMPLETED:[]}},
 NONE:{label:'No fulfillment',transitions:{PENDING:['COMPLETED','CANCELLED','FAILED'],COMPLETED:[]}},
};

export function fulfillmentTypeFor(productType,mode){
 if(productType==='FOOD')return mode==='PICKUP'?'FOOD_PICKUP':'FOOD_DELIVERY';
 if(productType==='DIGITAL')return mode==='DIGITAL_ACCESS'?'DIGITAL_ACCESS':'DIGITAL_DOWNLOAD';
 if(productType==='SERVICE')return 'SERVICE';
 if(mode==='PICKUP')return 'PHYSICAL_PICKUP';
 if(mode==='LOCAL_DELIVERY')return 'PHYSICAL_LOCAL_DELIVERY';
 if(mode==='SHIPPING')return 'PHYSICAL_SHIPPING';
 return 'NONE';
}
export function fulfillmentWorkflowForType(type){return {type,label:WORKFLOWS[type]?.label||type};}
export function allowedFulfillmentTransitionsForType(type,from){return [...(WORKFLOWS[type]?.transitions?.[from]||[])];}
export function assertFulfillmentTypeTransition(type,from,to){const allowed=allowedFulfillmentTransitionsForType(type,from);if(!allowed.includes(to))throw errors.conflict('FULFILLMENT_TRANSITION_INVALID',`${fulfillmentWorkflowForType(type).label} cannot transition from ${from} to ${to}`);}
// Backward-compatible helpers for older callers where order type == item type.
export function fulfillmentWorkflow(orderType,mode){return fulfillmentWorkflowForType(fulfillmentTypeFor(orderType,mode));}
export function allowedFulfillmentTransitions(orderType,mode,from){return allowedFulfillmentTransitionsForType(fulfillmentTypeFor(orderType,mode),from);}
export function assertFulfillmentTransition(orderType,mode,from,to){
 // Compatibility with the v0.4 two-argument helper used by older core callers.
 if(arguments.length===2){const legacyFrom=orderType,legacyTo=mode;const allowed=allowedFulfillmentTransitionsForType('PHYSICAL_SHIPPING',legacyFrom);if(!allowed.includes(legacyTo))throw errors.conflict('FULFILLMENT_TRANSITION_INVALID',`Fulfillment cannot transition from ${legacyFrom} to ${legacyTo}`);return;}
 return assertFulfillmentTypeTransition(fulfillmentTypeFor(orderType,mode),from,to);
}

export async function resolveDeliverySelection(client,{tenantId,storeId,cartItems,subtotal,deliveryMethodRef=null}){
 const physicalModes=[...new Set(cartItems.map(r=>r.fulfillment_mode).filter(m=>PHYSICAL_MODES.has(m)))];
 if(physicalModes.length===0)return {method:null,deliveryTotal:0,mode:null};
 if(physicalModes.length>1)throw errors.conflict('DELIVERY_MODE_MIXED_UNSUPPORTED','Checkout currently requires one physical delivery mode per order');
 const mode=physicalModes[0],params=[tenantId,storeId,mode];let filter="tenant_id=$1 AND store_id=$2 AND fulfillment_mode=$3 AND status='ACTIVE'";
 if(deliveryMethodRef){params.push(deliveryMethodRef);filter+=` AND (public_id=$4 OR code=$4)`;}
 const found=await client.query(`SELECT * FROM delivery_methods WHERE ${filter} ORDER BY sort_order,created_at LIMIT 1`,params);
 if(!found.rowCount)throw errors.notFound('DELIVERY_METHOD_NOT_FOUND','Active delivery method not found for selected fulfillment mode');
 const method=found.rows[0];if(Number(subtotal)<Number(method.min_order))throw errors.conflict('DELIVERY_MIN_ORDER','Order subtotal does not meet delivery method minimum');
 const fee=method.free_over!=null&&Number(subtotal)>=Number(method.free_over)?0:Number(method.flat_fee);return {method,deliveryTotal:money(fee),mode};
}

export async function createOrderFulfillments(client,{tenantId,storeId,orderId,cartItems,deliverySelection}){
 const groups=new Map();
 for(const item of cartItems){const productType=item.product_type||'PHYSICAL',mode=item.fulfillment_mode||'NONE',type=fulfillmentTypeFor(productType,mode),key=`${type}|${mode}`;if(!groups.has(key))groups.set(key,{type,mode,productType});}
 const created=[];let deliveryFeeAssigned=false;
 for(const group of groups.values()){
   const method=deliverySelection.method&&deliverySelection.mode===group.mode?deliverySelection.method:null;
   const fee=method&&!deliveryFeeAssigned?deliverySelection.deliveryTotal:0;if(method)deliveryFeeAssigned=true;
   const row=await client.query(`INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,delivery_method_id,fulfillment_mode,fulfillment_type,status,fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9) RETURNING *`,[uuid(),publicId('ful'),tenantId,storeId,orderId,method?.id||null,group.mode,group.type,fee]);
   await client.query(`INSERT INTO fulfillment_status_history(tenant_id,store_id,fulfillment_id,from_status,to_status,reason,actor_type) VALUES($1,$2,$3,NULL,'PENDING','Checkout created','SYSTEM')`,[tenantId,storeId,row.rows[0].id]);
   await client.query(`UPDATE order_items SET fulfillment_id=$1 WHERE tenant_id=$2 AND store_id=$3 AND order_id=$4 AND product_type_snapshot=$5 AND fulfillment_mode=$6 AND fulfillment_id IS NULL`,[row.rows[0].id,tenantId,storeId,orderId,group.productType,group.mode]);
   created.push(row.rows[0]);
 }
 return created;
}

export async function fulfillmentDetails(db,tenantId,orderRef,{customerId=null}={}){
 const params=[tenantId,orderRef];let customer='';if(customerId){params.push(customerId);customer=` AND o.customer_id=$${params.length}`;}
 const rows=await db.query(`SELECT f.public_id AS id,f.fulfillment_mode,f.fulfillment_type,f.status,f.fee,f.carrier,f.tracking_number,f.tracking_url,f.external_reference,f.estimated_at,f.estimated_ready_at,f.estimated_delivery_at,f.shipped_at,f.delivered_at,f.created_at,f.updated_at,dm.public_id AS delivery_method_id,dm.code AS delivery_method_code,dm.name AS delivery_method_name,o.public_id AS order_id,o.order_number,o.order_type FROM order_fulfillments f JOIN orders o ON o.id=f.order_id AND o.tenant_id=f.tenant_id AND o.store_id=f.store_id LEFT JOIN delivery_methods dm ON dm.id=f.delivery_method_id AND dm.tenant_id=f.tenant_id AND dm.store_id=f.store_id WHERE f.tenant_id=$1 AND (o.public_id=$2 OR o.order_number=$2)${customer} ORDER BY f.created_at`,params);
 if(!rows.rowCount)return [];
 for(const row of rows.rows){
   const [history,items]=await Promise.all([
     db.query(`SELECT h.from_status,h.to_status,h.reason,h.actor_type,h.created_at FROM fulfillment_status_history h JOIN order_fulfillments f ON f.id=h.fulfillment_id AND f.tenant_id=h.tenant_id AND f.store_id=h.store_id WHERE h.tenant_id=$1 AND f.public_id=$2 ORDER BY h.created_at,h.id`,[tenantId,row.id]),
     db.query(`SELECT oi.public_id AS id,oi.title_snapshot,oi.variant_title_snapshot,oi.quantity,oi.product_type_snapshot,oi.fulfillment_mode FROM order_items oi JOIN order_fulfillments f ON f.id=oi.fulfillment_id AND f.tenant_id=oi.tenant_id AND f.store_id=oi.store_id WHERE oi.tenant_id=$1 AND f.public_id=$2 ORDER BY oi.created_at,oi.id`,[tenantId,row.id]),
   ]);
   row.status_history=history.rows;row.items=items.rows;row.workflow=fulfillmentWorkflowForType(row.fulfillment_type);row.allowed_transitions=allowedFulfillmentTransitionsForType(row.fulfillment_type,row.status);
 }
 return rows.rows;
}
