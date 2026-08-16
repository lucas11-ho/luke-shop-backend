import { errors } from '../../core/errors.js';
import { publicId } from '../../core/identifiers.js';
import { writeAudit } from '../../core/audit.js';

const TERMINAL_ORDER = new Set(['DELIVERED','COMPLETED','CANCELLED','REFUNDED']);
const TERMINAL_FULFILLMENT = new Set(['DELIVERED','COMPLETED','PICKED_UP','FAILED','CANCELLED']);
const locationBody = {
  type:'object', additionalProperties:false, required:['latitude','longitude','location_source'], properties:{
    latitude:{type:'number',minimum:-90,maximum:90}, longitude:{type:'number',minimum:-180,maximum:180},
    accuracy_meters:{type:['number','null'],minimum:0,maximum:100000}, location_source:{type:'string',enum:['GPS','MAP_PIN','ADDRESS']},
  },
};
const pingBody = {
  type:'object', additionalProperties:false, required:['latitude','longitude'], properties:{
    latitude:{type:'number',minimum:-90,maximum:90}, longitude:{type:'number',minimum:-180,maximum:180},
    accuracy_meters:{type:['number','null'],minimum:0,maximum:100000},
  },
};

async function ownedOrder(client, tenantId, customerId, orderRef, { lock=false } = {}) {
  const result = await client.query(
    `SELECT o.* FROM orders o WHERE o.tenant_id=$1 AND o.customer_id=$2 AND (o.public_id=$3 OR o.order_number=$3)${lock?' FOR UPDATE':''}`,
    [tenantId,customerId,orderRef],
  );
  if (!result.rowCount) throw errors.notFound('ORDER_NOT_FOUND','Order not found');
  return result.rows[0];
}

async function ensureLocationMutable(client, order) {
  if (TERMINAL_ORDER.has(order.status)) throw errors.conflict('DELIVERY_LOCATION_LOCKED','Delivery location can no longer be changed for this order');
  const fulfillment = await client.query(
    `SELECT status FROM order_fulfillments WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3
       AND fulfillment_type IN ('PHYSICAL_SHIPPING','PHYSICAL_LOCAL_DELIVERY','FOOD_DELIVERY') ORDER BY created_at`,
    [order.tenant_id,order.store_id,order.id],
  );
  if (fulfillment.rowCount && fulfillment.rows.every((row)=>TERMINAL_FULFILLMENT.has(row.status))) throw errors.conflict('DELIVERY_LOCATION_LOCKED','Delivery location can no longer be changed for this fulfillment');
}

export async function customerDeliveryLocationRoutes(app) {
  app.patch('/v1/customer/me/addresses/:addressRef/location', {
    preHandler:[app.requireCustomerAuth], schema:{body:locationBody},
  }, async(request) => app.db.transaction(async(client) => {
    const updated = await client.query(
      `UPDATE customer_addresses SET latitude=$1,longitude=$2,accuracy_meters=$3,location_source=$4,location_updated_at=now(),updated_at=now()
       WHERE tenant_id=$5 AND customer_id=$6 AND public_id=$7
       RETURNING public_id AS id,latitude,longitude,accuracy_meters,location_source,location_updated_at`,
      [request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,request.body.location_source,request.auth.tenantId,request.auth.actorId,request.params.addressRef],
    );
    if (!updated.rowCount) throw errors.notFound('ADDRESS_NOT_FOUND','Saved address not found');
    await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'customer.address.location.update',targetType:'customer_address',targetId:null,metadata:{address_id:request.params.addressRef,accuracy_meters:request.body.accuracy_meters??null,location_source:request.body.location_source},requestIp:request.ip,requestId:request.id});
    return {data:{location:updated.rows[0]}};
  }));

  app.patch('/v1/customer/orders/:orderRef/delivery-location', {
    preHandler:[app.requireCustomerAuth], schema:{body:locationBody},
  }, async(request) => app.db.transaction(async(client) => {
    const order = await ownedOrder(client,request.auth.tenantId,request.auth.actorId,request.params.orderRef,{lock:true});
    await ensureLocationMutable(client,order);
    const updated = await client.query(
      `UPDATE order_addresses SET latitude=$1,longitude=$2,accuracy_meters=$3,location_source=$4,location_updated_at=now()
       WHERE tenant_id=$5 AND store_id=$6 AND order_id=$7
       RETURNING latitude,longitude,accuracy_meters,location_source,location_updated_at`,
      [request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,request.body.location_source,request.auth.tenantId,order.store_id,order.id],
    );
    if (!updated.rowCount) throw errors.conflict('ORDER_DELIVERY_ADDRESS_MISSING','This order does not have a delivery address');
    await client.query(
      `INSERT INTO order_delivery_location_events(tenant_id,store_id,order_id,customer_id,latitude,longitude,accuracy_meters,location_source,event_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CUSTOMER_UPDATE')`,
      [request.auth.tenantId,order.store_id,order.id,request.auth.actorId,request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,request.body.location_source],
    );
    await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'order.delivery_location.update',targetType:'order',targetId:order.id,metadata:{accuracy_meters:request.body.accuracy_meters??null,location_source:request.body.location_source},requestIp:request.ip,requestId:request.id});
    return {data:{delivery_location:updated.rows[0]}};
  }));

  app.post('/v1/customer/orders/:orderRef/live-location/start', {
    preHandler:[app.requireCustomerAuth], config:{rateLimit:{max:10,timeWindow:'1 minute'}},
  }, async(request) => app.db.transaction(async(client) => {
    const order = await ownedOrder(client,request.auth.tenantId,request.auth.actorId,request.params.orderRef,{lock:true});
    await ensureLocationMutable(client,order);
    await client.query(`UPDATE customer_live_location_sessions SET status='EXPIRED',stopped_at=COALESCE(stopped_at,now()),stop_reason='REPLACED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND customer_id=$4 AND status='ACTIVE'`,[request.auth.tenantId,order.store_id,order.id,request.auth.actorId]);
    const sessionId=publicId('locs');
    const created=await client.query(
      `INSERT INTO customer_live_location_sessions(public_id,tenant_id,store_id,order_id,customer_id,status,expires_at)
       VALUES($1,$2,$3,$4,$5,'ACTIVE',now()+interval '4 hours') RETURNING public_id AS session_id,status,started_at,expires_at`,
      [sessionId,request.auth.tenantId,order.store_id,order.id,request.auth.actorId],
    );
    await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'order.live_location.start',targetType:'order',targetId:order.id,metadata:{session_id:sessionId},requestIp:request.ip,requestId:request.id});
    return {data:created.rows[0]};
  }));

  app.post('/v1/customer/orders/:orderRef/live-location/ping', {
    preHandler:[app.requireCustomerAuth], config:{rateLimit:{max:120,timeWindow:'1 minute'}}, schema:{body:pingBody},
  }, async(request) => app.db.transaction(async(client) => {
    const order = await ownedOrder(client,request.auth.tenantId,request.auth.actorId,request.params.orderRef);
    await ensureLocationMutable(client,order);
    const session=await client.query(
      `SELECT * FROM customer_live_location_sessions WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND customer_id=$4 AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [request.auth.tenantId,order.store_id,order.id,request.auth.actorId],
    );
    if (!session.rowCount) throw errors.conflict('LIVE_LOCATION_NOT_ACTIVE','Start live location sharing first');
    if (new Date(session.rows[0].expires_at)<=new Date()) {
      await client.query(`UPDATE customer_live_location_sessions SET status='EXPIRED',stopped_at=now(),stop_reason='EXPIRED',updated_at=now() WHERE id=$1`,[session.rows[0].id]);
      throw errors.conflict('LIVE_LOCATION_EXPIRED','Live location session expired');
    }
    const previousPingAt=session.rows[0].last_ping_at?new Date(session.rows[0].last_ping_at):null;
    await client.query(`UPDATE customer_live_location_sessions SET last_latitude=$1,last_longitude=$2,last_accuracy_meters=$3,last_ping_at=now(),updated_at=now() WHERE id=$4`,[request.body.latitude,request.body.longitude,request.body.accuracy_meters??null,session.rows[0].id]);
    // Keep the current live point fresh without writing a permanent history row every 5 seconds.
    // Sample the audit/location event ledger at most once per minute per active session.
    if(!previousPingAt||Date.now()-previousPingAt.getTime()>=60000){
      await client.query(`INSERT INTO order_delivery_location_events(tenant_id,store_id,order_id,customer_id,latitude,longitude,accuracy_meters,location_source,event_type) VALUES($1,$2,$3,$4,$5,$6,$7,'GPS','LIVE_PING')`,[request.auth.tenantId,order.store_id,order.id,request.auth.actorId,request.body.latitude,request.body.longitude,request.body.accuracy_meters??null]);
    }
    return {data:{accepted:true,received_at:new Date().toISOString()}};
  }));

  app.post('/v1/customer/orders/:orderRef/live-location/stop', {
    preHandler:[app.requireCustomerAuth],
  }, async(request) => app.db.transaction(async(client) => {
    const order=await ownedOrder(client,request.auth.tenantId,request.auth.actorId,request.params.orderRef);
    await client.query(`UPDATE customer_live_location_sessions SET status='STOPPED',stopped_at=now(),stop_reason='CUSTOMER',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND customer_id=$4 AND status='ACTIVE'`,[request.auth.tenantId,order.store_id,order.id,request.auth.actorId]);
    await writeAudit(client,{tenantId:request.auth.tenantId,actorType:'CUSTOMER',actorId:request.auth.actorId,action:'order.live_location.stop',targetType:'order',targetId:order.id,metadata:{},requestIp:request.ip,requestId:request.id});
    return {data:{stopped:true}};
  }));
}
