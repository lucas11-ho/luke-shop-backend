import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { money } from '../orders/service.js';

const PHYSICAL_MODES=new Set(['SHIPPING','LOCAL_DELIVERY','PICKUP']);
const TRANSITIONS={
  PENDING:['PREPARING','READY','SHIPPED','CANCELLED','FAILED'], PREPARING:['READY','SHIPPED','CANCELLED','FAILED'],
  READY:['SHIPPED','OUT_FOR_DELIVERY','PICKED_UP','DELIVERED','COMPLETED','FAILED'], SHIPPED:['OUT_FOR_DELIVERY','DELIVERED','FAILED'],
  OUT_FOR_DELIVERY:['DELIVERED','FAILED'], PICKED_UP:['COMPLETED'], DELIVERED:['COMPLETED'],
};

export function assertFulfillmentTransition(from,to){if(!(TRANSITIONS[from]||[]).includes(to)) throw errors.conflict('FULFILLMENT_TRANSITION_INVALID',`Fulfillment cannot transition from ${from} to ${to}`);}

export async function resolveDeliverySelection(client,{tenantId,storeId,cartItems,subtotal,deliveryMethodRef=null}){
  const physicalModes=[...new Set(cartItems.map(r=>r.fulfillment_mode).filter(m=>PHYSICAL_MODES.has(m)))];
  if(physicalModes.length===0) return {method:null,deliveryTotal:0,mode:null};
  if(physicalModes.length>1) throw errors.conflict('DELIVERY_MODE_MIXED_UNSUPPORTED','Checkout currently requires one physical delivery mode per order');
  const mode=physicalModes[0];const params=[tenantId,storeId,mode];let filter="tenant_id=$1 AND store_id=$2 AND fulfillment_mode=$3 AND status='ACTIVE'";
  if(deliveryMethodRef){params.push(deliveryMethodRef);filter+=` AND (public_id=$4 OR code=$4)`;}
  const found=await client.query(`SELECT * FROM delivery_methods WHERE ${filter} ORDER BY sort_order,created_at LIMIT 1`,params);
  if(!found.rowCount) throw errors.notFound('DELIVERY_METHOD_NOT_FOUND','Active delivery method not found for selected fulfillment mode');
  const method=found.rows[0];if(Number(subtotal)<Number(method.min_order)) throw errors.conflict('DELIVERY_MIN_ORDER','Order subtotal does not meet delivery method minimum');
  const fee=method.free_over!=null&&Number(subtotal)>=Number(method.free_over)?0:Number(method.flat_fee);
  return {method,deliveryTotal:money(fee),mode};
}

export async function createOrderFulfillments(client,{tenantId,storeId,orderId,cartItems,deliverySelection}){
  const modes=[...new Set(cartItems.map(r=>r.fulfillment_mode))];const created=[];
  for(const mode of modes){const method=deliverySelection.method&&deliverySelection.mode===mode?deliverySelection.method:null;const fee=method?deliverySelection.deliveryTotal:0;
    const row=await client.query(`INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,delivery_method_id,fulfillment_mode,status,fee)
      VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8) RETURNING *`,[uuid(),publicId('ful'),tenantId,storeId,orderId,method?.id||null,mode,fee]);
    await client.query(`INSERT INTO fulfillment_status_history(tenant_id,store_id,fulfillment_id,from_status,to_status,reason,actor_type) VALUES($1,$2,$3,NULL,'PENDING','Checkout created','SYSTEM')`,[tenantId,storeId,row.rows[0].id]);
    created.push(row.rows[0]);}
  return created;
}

export async function fulfillmentDetails(db,tenantId,orderRef,{customerId=null}={}){
  const params=[tenantId,orderRef];let customer='';if(customerId){params.push(customerId);customer=` AND o.customer_id=$${params.length}`;}
  const rows=await db.query(`SELECT f.public_id AS id,f.fulfillment_mode,f.status,f.fee,f.carrier,f.tracking_number,f.tracking_url,f.external_reference,f.estimated_at,f.shipped_at,f.delivered_at,f.created_at,f.updated_at,
      dm.public_id AS delivery_method_id,dm.code AS delivery_method_code,dm.name AS delivery_method_name,o.public_id AS order_id,o.order_number
    FROM order_fulfillments f JOIN orders o ON o.id=f.order_id AND o.tenant_id=f.tenant_id AND o.store_id=f.store_id
    LEFT JOIN delivery_methods dm ON dm.id=f.delivery_method_id AND dm.tenant_id=f.tenant_id AND dm.store_id=f.store_id
    WHERE f.tenant_id=$1 AND (o.public_id=$2 OR o.order_number=$2)${customer} ORDER BY f.created_at`,params);
  if(!rows.rowCount) return [];
  for(const row of rows.rows){const history=await db.query(`SELECT h.from_status,h.to_status,h.reason,h.actor_type,h.created_at FROM fulfillment_status_history h JOIN order_fulfillments f ON f.id=h.fulfillment_id AND f.tenant_id=h.tenant_id AND f.store_id=h.store_id WHERE h.tenant_id=$1 AND f.public_id=$2 ORDER BY h.created_at,h.id`,[tenantId,row.id]);row.status_history=history.rows;}
  return rows.rows;
}
