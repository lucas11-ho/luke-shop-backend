import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { money } from '../orders/service.js';
import { persistVipOrderSnapshots, resolveVipCheckoutBenefits } from '../loyalty/execution.js';
import { prepareOrderDigitalEntitlements } from '../digital-delivery/service.js';

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
 if(productType==='DIGITAL_IMAGE'||productType==='DIGITAL_VIDEO')return mode==='DIGITAL_DOWNLOAD'?'DIGITAL_DOWNLOAD':'DIGITAL_ACCESS';
 if(productType==='SERVICE')return 'SERVICE';
 if(mode==='PICKUP')return 'PHYSICAL_PICKUP';
 if(mode==='LOCAL_DELIVERY')return 'PHYSICAL_LOCAL_DELIVERY';
 if(mode==='SHIPPING')return 'PHYSICAL_SHIPPING';
 return 'NONE';
}
export function fulfillmentWorkflowForType(type){return {type,label:WORKFLOWS[type]?.label||type};}
export function allowedFulfillmentTransitionsForType(type,from){return [...(WORKFLOWS[type]?.transitions?.[from]||[])];}
export function assertFulfillmentTypeTransition(type,from,to){const allowed=allowedFulfillmentTransitionsForType(type,from);if(!allowed.includes(to))throw errors.conflict('FULFILLMENT_TRANSITION_INVALID',`${fulfillmentWorkflowForType(type).label} cannot transition from ${from} to ${to}`);}
export function fulfillmentWorkflow(orderType,mode){return fulfillmentWorkflowForType(fulfillmentTypeFor(orderType,mode));}
export function allowedFulfillmentTransitions(orderType,mode,from){return allowedFulfillmentTransitionsForType(fulfillmentTypeFor(orderType,mode),from);}
export function assertFulfillmentTransition(orderType,mode,from,to){
 if(arguments.length===2){const legacyFrom=orderType,legacyTo=mode;const allowed=allowedFulfillmentTransitionsForType('PHYSICAL_SHIPPING',legacyFrom);if(!allowed.includes(legacyTo))throw errors.conflict('FULFILLMENT_TRANSITION_INVALID',`Fulfillment cannot transition from ${legacyFrom} to ${legacyTo}`);return;}
 return assertFulfillmentTypeTransition(fulfillmentTypeFor(orderType,mode),from,to);
}

const normalized=value=>String(value??'').trim().toLowerCase();
const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
export function haversineDistanceKm(lat1,lon1,lat2,lon2){
 if(![lat1,lon1,lat2,lon2].every(finite))return Infinity;
 const rad=value=>Number(value)*Math.PI/180,dLat=rad(Number(lat2)-Number(lat1)),dLon=rad(Number(lon2)-Number(lon1));
 const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
export function deliveryZoneMatchesAddress(zone,address){
 if(!zone||!address)return false;
 if(zone.match_type==='COUNTRY_REGION'){
  const country=String(address.country_code||'').trim().toUpperCase(),countries=(zone.country_codes||[]).map(value=>String(value).trim().toUpperCase());
  if(!country||!countries.includes(country))return false;
  const regions=(zone.region_names||[]).map(normalized).filter(Boolean);if(!regions.length)return true;
  const candidates=[address.state,address.city].map(normalized).filter(Boolean);return candidates.some(value=>regions.includes(value));
 }
 if(zone.match_type==='RADIUS'){
  if(!finite(address.latitude)||!finite(address.longitude)||!finite(zone.center_latitude)||!finite(zone.center_longitude)||!finite(zone.radius_km))return false;
  return haversineDistanceKm(address.latitude,address.longitude,zone.center_latitude,zone.center_longitude)<=Number(zone.radius_km);
 }
 return false;
}

function baselineAmount(method,subtotal){
 if(Number(subtotal)<Number(method.min_order))throw errors.conflict('DELIVERY_MIN_ORDER','Order subtotal does not meet delivery method minimum');
 return money(method.free_over!=null&&Number(subtotal)>=Number(method.free_over)?0:Number(method.flat_fee));
}
function publicPricingSnapshot({method,source,zone=null,rate=null,resolvedFee}){
 return {
  pricing_mode:method.pricing_mode||'BASELINE',pricing_source:source,delivery_method_id:method.public_id,delivery_method_code:method.code,
  no_match_policy:method.zone_no_match_policy||'UNAVAILABLE',zone:zone?{id:zone.public_id,code:zone.code,name:zone.name,match_type:zone.match_type}:null,
  rate:rate?{id:rate.public_id,flat_fee:money(rate.flat_fee),free_over:rate.free_over==null?null:money(rate.free_over),min_order:money(rate.min_order),estimated_min_minutes:rate.estimated_min_minutes,estimated_max_minutes:rate.estimated_max_minutes,priority:rate.priority}:null,
  resolved_fee_before_vip:money(resolvedFee),
 };
}
async function zoneAwareAmount(client,{tenantId,storeId,method,subtotal,shippingAddress}){
 const candidates=await client.query(`SELECT r.*,z.public_id AS zone_public_id,z.code AS zone_code,z.name AS zone_name,z.status AS zone_status,z.match_type,z.country_codes,z.region_names,z.center_latitude,z.center_longitude,z.radius_km,z.sort_order AS zone_sort_order
   FROM delivery_zone_rates r JOIN delivery_zones z ON z.id=r.zone_id AND z.tenant_id=r.tenant_id AND z.store_id=r.store_id
   WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.delivery_method_id=$3 AND r.status='ACTIVE' AND z.status='ACTIVE'
   ORDER BY r.priority,z.sort_order,r.created_at,r.id`,[tenantId,storeId,method.id]);
 const matched=candidates.rows.find(row=>deliveryZoneMatchesAddress(row,shippingAddress));
 if(!matched){
  if(method.zone_no_match_policy==='BASELINE_FALLBACK'){
   const amount=baselineAmount(method,subtotal);return {amount,zone:null,rate:null,snapshot:publicPricingSnapshot({method,source:'BASELINE_FALLBACK',resolvedFee:amount})};
  }
  throw errors.conflict('DELIVERY_ZONE_UNAVAILABLE','The selected delivery method is not available for this address');
 }
 if(Number(subtotal)<Number(matched.min_order))throw errors.conflict('DELIVERY_ZONE_MIN_ORDER','Order subtotal does not meet the matched delivery-zone minimum');
 const amount=money(matched.free_over!=null&&Number(subtotal)>=Number(matched.free_over)?0:Number(matched.flat_fee));
 const zone={id:matched.zone_id,public_id:matched.zone_public_id,code:matched.zone_code,name:matched.zone_name,match_type:matched.match_type};
 const rate={...matched};return {amount,zone,rate,snapshot:publicPricingSnapshot({method,source:'ZONE_RATE',zone,rate,resolvedFee:amount})};
}

export async function resolveDeliverySelection(client,{tenantId,storeId,cartItems,subtotal,deliveryMethodRef=null,shippingAddress=null}){
 const cartId=cartItems[0]?.cart_id||null;let customerId=null;
 if(cartId){const owner=await client.query(`SELECT customer_id FROM carts WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tenantId,storeId,cartId]);customerId=owner.rows[0]?.customer_id||null;}
 const physicalModes=[...new Set(cartItems.map(r=>r.fulfillment_mode).filter(m=>PHYSICAL_MODES.has(m)))];
 let method=null,mode=null,baseDeliveryTotal=0,zone=null,rate=null,pricingSnapshot=null;
 if(physicalModes.length>1)throw errors.conflict('DELIVERY_MODE_MIXED_UNSUPPORTED','Checkout currently requires one physical delivery mode per order');
 if(physicalModes.length===1){
  mode=physicalModes[0];const params=[tenantId,storeId,mode];let filter="tenant_id=$1 AND store_id=$2 AND fulfillment_mode=$3 AND status='ACTIVE'";
  if(deliveryMethodRef){params.push(deliveryMethodRef);filter+=` AND (public_id=$4 OR code=$4)`;}
  const found=await client.query(`SELECT * FROM delivery_methods WHERE ${filter} ORDER BY sort_order,created_at LIMIT 1`,params);
  if(!found.rowCount)throw errors.notFound('DELIVERY_METHOD_NOT_FOUND','Active delivery method not found for selected fulfillment mode');
  method=found.rows[0];
  if(method.pricing_mode==='ZONE_AWARE'){
   if(!['SHIPPING','LOCAL_DELIVERY'].includes(mode))throw errors.conflict('DELIVERY_ZONE_PRICING_MODE_INVALID','Zone-aware pricing is available only for shipping or local delivery');
   const selected=await zoneAwareAmount(client,{tenantId,storeId,method,subtotal,shippingAddress});baseDeliveryTotal=selected.amount;zone=selected.zone;rate=selected.rate;pricingSnapshot=selected.snapshot;
  }else{
   baseDeliveryTotal=baselineAmount(method,subtotal);pricingSnapshot=publicPricingSnapshot({method,source:'BASELINE',resolvedFee:baseDeliveryTotal});
  }
 }
 const vip=customerId?await resolveVipCheckoutBenefits(client,{tenantId,storeId,customerId,subtotal,deliveryMethod:method,deliveryAmount:baseDeliveryTotal}):{enabled:false,deliveryDiscount:0,snapshots:[]};
 const deliveryTotal=money(Math.max(0,baseDeliveryTotal-Number(vip.deliveryDiscount||0)));
 if(pricingSnapshot){pricingSnapshot={...pricingSnapshot,vip_discount:money(vip.deliveryDiscount||0),fulfillment_fee_before_promotion:deliveryTotal};}
 return {method,baseDeliveryTotal,deliveryTotal,mode,vip,zone,rate,pricingSnapshot};
}

export async function createOrderFulfillments(client,{tenantId,storeId,orderId,cartItems,deliverySelection}){
 const groups=new Map();
 for(const item of cartItems){const productType=item.product_type||'PHYSICAL',mode=item.fulfillment_mode||'NONE',type=fulfillmentTypeFor(productType,mode),key=`${type}|${mode}`;if(!groups.has(key))groups.set(key,{type,mode,productType});}
 const created=[];let deliveryFeeAssigned=false;
 for(const group of groups.values()){
  const method=deliverySelection.method&&deliverySelection.mode===group.mode?deliverySelection.method:null;
  const fee=method&&!deliveryFeeAssigned?deliverySelection.deliveryTotal:0;if(method)deliveryFeeAssigned=true;
  const zoneId=method?deliverySelection.zone?.id||null:null,rateId=method?deliverySelection.rate?.id||null:null,snapshot=method?deliverySelection.pricingSnapshot||{}:{};
  const row=await client.query(`INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,delivery_method_id,fulfillment_mode,fulfillment_type,status,fee,delivery_zone_id,delivery_zone_rate_id,delivery_pricing_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12::jsonb) RETURNING *`,[uuid(),publicId('ful'),tenantId,storeId,orderId,method?.id||null,group.mode,group.type,fee,zoneId,rateId,JSON.stringify(snapshot)]);
  await client.query(`INSERT INTO fulfillment_status_history(tenant_id,store_id,fulfillment_id,from_status,to_status,reason,actor_type) VALUES($1,$2,$3,NULL,'PENDING','Checkout created','SYSTEM')`,[tenantId,storeId,row.rows[0].id]);
  await client.query(`UPDATE order_items SET fulfillment_id=$1 WHERE tenant_id=$2 AND store_id=$3 AND order_id=$4 AND product_type_snapshot=$5 AND fulfillment_mode=$6 AND fulfillment_id IS NULL`,[row.rows[0].id,tenantId,storeId,orderId,group.productType,group.mode]);
  created.push(row.rows[0]);
 }
 await persistVipOrderSnapshots(client,{tenantId,storeId,orderId,deliverySelection});
 await prepareOrderDigitalEntitlements(client,{tenantId,storeId,orderId});
 return created;
}

export async function fulfillmentDetails(db,tenantId,orderRef,{customerId=null}={}){
 const params=[tenantId,orderRef];let customer='';if(customerId){params.push(customerId);customer=` AND o.customer_id=$${params.length}`;}
 const rows=await db.query(`SELECT f.public_id AS id,f.fulfillment_mode,f.fulfillment_type,f.status,f.fee,f.carrier,f.tracking_number,f.tracking_url,f.external_reference,f.estimated_at,f.estimated_ready_at,f.estimated_delivery_at,f.shipped_at,f.delivered_at,f.delivery_pricing_snapshot,f.created_at,f.updated_at,dm.public_id AS delivery_method_id,dm.code AS delivery_method_code,dm.name AS delivery_method_name,dz.public_id AS delivery_zone_id,dzr.public_id AS delivery_zone_rate_id,o.public_id AS order_id,o.order_number,o.order_type FROM order_fulfillments f JOIN orders o ON o.id=f.order_id AND o.tenant_id=f.tenant_id AND o.store_id=f.store_id LEFT JOIN delivery_methods dm ON dm.id=f.delivery_method_id AND dm.tenant_id=f.tenant_id AND dm.store_id=f.store_id LEFT JOIN delivery_zones dz ON dz.id=f.delivery_zone_id AND dz.tenant_id=f.tenant_id AND dz.store_id=f.store_id LEFT JOIN delivery_zone_rates dzr ON dzr.id=f.delivery_zone_rate_id AND dzr.tenant_id=f.tenant_id AND dzr.store_id=f.store_id WHERE f.tenant_id=$1 AND (o.public_id=$2 OR o.order_number=$2)${customer} ORDER BY f.created_at`,params);
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
