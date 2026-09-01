import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createDatabase}from'../src/db/pool.js';
import{loadConfig}from'../src/config.js';
import{resolvePushRecipients}from'../src/modules/notifications/push-service.js';

const db=createDatabase(loadConfig()),suffix=randomUUID().replaceAll('-','').slice(0,10);
const ids={tenant:randomUUID(),otherTenant:randomUUID(),storeA:randomUUID(),storeB:randomUUID(),otherStore:randomUUID(),kitchenA:randomUUID(),kitchenB:randomUUID(),finance:randomUUID(),partial:randomUUID(),driverA:randomUUID(),driverB:randomUUID()};
const refs={tenant:`tnt_push_${suffix}`,otherTenant:`tnt_push_other_${suffix}`,storeA:`str_push_a_${suffix}`,storeB:`str_push_b_${suffix}`,otherStore:`str_push_other_${suffix}`};
const sub=(user,label)=>[randomUUID(),`sps_${label}_${suffix}`,ids.tenant,user,`https://fcm.googleapis.com/fcm/send/${label}-${suffix}`,`${label}${'A'.repeat(63)}`.slice(0,64),`B${'C'.repeat(31)}`,label];
const event=(patch={})=>({tenant_id:ids.tenant,store_id:ids.storeA,category:'KITCHEN_NEW_ORDER',target_user_ids:[],target_role_keys:['KITCHEN'],target_permission_keys:[],permission_mode:'ANY',...patch});
try{
 await db.transaction(async client=>{
  await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE'),($5,$6,$7,$8,'ACTIVE')",[ids.tenant,refs.tenant,`push-${suffix}`,`Push ${suffix}`,ids.otherTenant,refs.otherTenant,`push-other-${suffix}`,`Push Other ${suffix}`]);
  await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1),($2)",[ids.tenant,ids.otherTenant]);
  await client.query("INSERT INTO stores(id,public_id,tenant_id,slug,name,status,is_primary) VALUES($1,$2,$3,$4,'Store A','ACTIVE',true),($5,$6,$3,$7,'Store B','ACTIVE',false),($8,$9,$10,$11,'Other','ACTIVE',true)",[ids.storeA,refs.storeA,ids.tenant,`push-a-${suffix}`,ids.storeB,refs.storeB,`push-b-${suffix}`,ids.otherStore,refs.otherStore,ids.otherTenant,`push-other-store-${suffix}`]);
  const passwordHash='scrypt$placeholder';
  for(const [id,label] of [[ids.kitchenA,'Kitchen A'],[ids.kitchenB,'Kitchen B'],[ids.finance,'Finance'],[ids.partial,'Partial'],[ids.driverA,'Driver A'],[ids.driverB,'Driver B']])await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status,store_access_mode) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE','ASSIGNED_STORES')",[id,`musr_${label.replaceAll(' ','_').toLowerCase()}_${suffix}`,ids.tenant,`${label.replaceAll(' ','-').toLowerCase()}-${suffix}@example.com`,passwordHash,label]);
  await client.query('INSERT INTO merchant_user_store_access(tenant_id,merchant_user_id,store_id) VALUES($1,$2,$3),($1,$4,$5),($1,$6,$3),($1,$7,$3),($1,$8,$3),($1,$9,$3)',[ids.tenant,ids.kitchenA,ids.storeA,ids.kitchenB,ids.storeB,ids.finance,ids.partial,ids.driverA,ids.driverB]);
  const kitchenRole=(await client.query("SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='KITCHEN'",[ids.tenant])).rows[0].id;
  await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3),($1,$4,$3)',[ids.tenant,ids.kitchenA,kitchenRole,ids.kitchenB]);
  const financeRole=randomUUID(),partialRole=randomUUID();
  await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'PUSH_FINANCE','Push Finance',false),($3,$2,'PUSH_PARTIAL','Push Partial',false)",[financeRole,ids.tenant,partialRole]);
  await client.query("INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,'delivery.manage'),($1,'payments.manage'),($2,'delivery.manage')",[financeRole,partialRole]);
  await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3),($1,$4,$5)',[ids.tenant,ids.finance,financeRole,ids.partial,partialRole]);
  for(const [user,label] of [[ids.kitchenA,'ka'],[ids.kitchenB,'kb'],[ids.finance,'fin'],[ids.partial,'partial']]){const v=sub(user,label);await client.query(`INSERT INTO staff_push_subscriptions(id,public_id,tenant_id,merchant_user_id,endpoint,endpoint_hash,p256dh,auth_secret,device_label) VALUES($1,$2,$3,$4,$5,encode(digest($5,'sha256'),'hex'),$6,$7,$8)`,v);}
  const otherUser=randomUUID();await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status) VALUES($1,$2,$3,$4,$5,'Other Kitchen','ACTIVE')",[otherUser,`musr_other_${suffix}`,ids.otherTenant,`other-${suffix}@example.com`,passwordHash]);
  const otherKitchenRole=(await client.query("SELECT id FROM merchant_roles WHERE tenant_id=$1 AND key='KITCHEN'",[ids.otherTenant])).rows[0].id;await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[ids.otherTenant,otherUser,otherKitchenRole]);
  await client.query(`INSERT INTO staff_push_subscriptions(public_id,tenant_id,merchant_user_id,endpoint,endpoint_hash,p256dh,auth_secret,device_label) VALUES($1,$2,$3,$4,encode(digest($4,'sha256'),'hex'),$5,$6,'other')`,[`sps_other_${suffix}`,ids.otherTenant,otherUser,`https://fcm.googleapis.com/fcm/send/other-${suffix}`,'D'.repeat(64),'E'.repeat(32)]);
 });

 let recipients=await resolvePushRecipients(db,event());
 assert.deepEqual(recipients.map(r=>r.merchant_user_id).sort(),[ids.kitchenA].sort(),'only the KITCHEN user assigned to Store A should receive Store A kitchen push');

 await db.query(`INSERT INTO staff_push_preferences(tenant_id,merchant_user_id,enabled,categories) VALUES($1,$2,true,'{"KITCHEN_NEW_ORDER":false}'::jsonb)`,[ids.tenant,ids.kitchenA]);
 recipients=await resolvePushRecipients(db,event());assert.equal(recipients.length,0,'per-user category disable must suppress push');
 await db.query('DELETE FROM staff_push_preferences WHERE tenant_id=$1 AND merchant_user_id=$2',[ids.tenant,ids.kitchenA]);
 await db.query(`INSERT INTO staff_push_store_settings(tenant_id,store_id,enabled,categories) VALUES($1,$2,true,'{"KITCHEN_NEW_ORDER":false}'::jsonb)`,[ids.tenant,ids.storeA]);
 recipients=await resolvePushRecipients(db,event());assert.equal(recipients.length,0,'store category disable must suppress push');
 await db.query('DELETE FROM staff_push_store_settings WHERE tenant_id=$1 AND store_id=$2',[ids.tenant,ids.storeA]);

 recipients=await resolvePushRecipients(db,event({category:'COD_RECONCILIATION',target_role_keys:[],target_permission_keys:['delivery.manage','payments.manage'],permission_mode:'ALL'}));
 assert.deepEqual(recipients.map(r=>r.merchant_user_id).sort(),[ids.finance].sort(),'ALL permission targeting must exclude staff missing payments.manage');

 await db.transaction(async client=>{
  const customer=randomUUID(),order=randomUUID(),fulfillment=randomUUID(),driverOne=randomUUID(),driverTwo=randomUUID(),dispatch=randomUUID();
  await client.query("INSERT INTO customers(id,public_id,tenant_id,display_name,status) VALUES($1,$2,$3,'Push Customer','ACTIVE')",[customer,`cus_push_${suffix}`,ids.tenant]);
  await client.query("INSERT INTO orders(id,public_id,order_number,tenant_id,store_id,customer_id,order_type,status,payment_status,currency) VALUES($1,$2,$3,$4,$5,$6,'PHYSICAL','OUT_FOR_DELIVERY','PAID','USD')",[order,`ord_push_${suffix}`,`PUSH-${suffix}`,ids.tenant,ids.storeA,customer]);
  await client.query("INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,fulfillment_mode,fulfillment_type,status) VALUES($1,$2,$3,$4,$5,'LOCAL_DELIVERY','PHYSICAL_LOCAL_DELIVERY','OUT_FOR_DELIVERY')",[fulfillment,`ful_push_${suffix}`,ids.tenant,ids.storeA,order]);
  await client.query("INSERT INTO delivery_drivers(id,public_id,tenant_id,store_id,merchant_user_id,display_name,status) VALUES($1,$2,$3,$4,$5,'Driver A','ACTIVE'),($6,$7,$3,$4,$8,'Driver B','ACTIVE')",[driverOne,`drv_a_${suffix}`,ids.tenant,ids.storeA,ids.driverA,driverTwo,`drv_b_${suffix}`,ids.driverB]);
  await client.query("INSERT INTO delivery_dispatches(id,public_id,tenant_id,store_id,fulfillment_id,driver_id,status) VALUES($1,$2,$3,$4,$5,$6,'OUT_FOR_DELIVERY')",[dispatch,`dsp_push_${suffix}`,ids.tenant,ids.storeA,fulfillment,driverOne]);
 });
 const dispatch=(await db.query("SELECT id,public_id,driver_id FROM delivery_dispatches WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3",[ids.tenant,ids.storeA,`dsp_push_${suffix}`])).rows[0];
 const secondDriver=(await db.query("SELECT id FROM delivery_drivers WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3",[ids.tenant,ids.storeA,`drv_b_${suffix}`])).rows[0].id;
 let blocked=false;try{await db.query('UPDATE delivery_dispatches SET driver_id=$1 WHERE id=$2',[secondDriver,dispatch.id]);}catch(error){blocked=error.code==='23514'&&error.constraint==='delivery_dispatch_in_transit_reassign_forbidden';}assert.equal(blocked,true,'OUT_FOR_DELIVERY reassignment must be blocked by migration 032');
 const assignmentEvent=await db.query("SELECT category,target_user_ids,title,body,route FROM staff_push_outbox WHERE tenant_id=$1 AND entity_ref=$2 AND category='DRIVER_ASSIGNMENT'",[ids.tenant,dispatch.public_id]);
 assert.equal(assignmentEvent.rowCount,1,'dispatch insert must enqueue one driver assignment event');
 assert.deepEqual(assignmentEvent.rows[0].target_user_ids.map(String),[ids.driverA]);
 assert.equal(/customer|phone|address/i.test(`${assignmentEvent.rows[0].title} ${assignmentEvent.rows[0].body}`),false,'push text must remain generic and customer-safe');

 const foodOrder=randomUUID(),foodFulfillment=randomUUID();const customerId=(await db.query('SELECT customer_id FROM orders WHERE tenant_id=$1 AND store_id=$2 LIMIT 1',[ids.tenant,ids.storeA])).rows[0].customer_id;
 await db.query("INSERT INTO orders(id,public_id,order_number,tenant_id,store_id,customer_id,order_type,status,payment_status,currency) VALUES($1,$2,$3,$4,$5,$6,'FOOD','PENDING_PAYMENT','PENDING','USD')",[foodOrder,`ord_food_push_${suffix}`,`FOOD-${suffix}`,ids.tenant,ids.storeA,customerId]);
 await db.query("INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,fulfillment_mode,fulfillment_type,status) VALUES($1,$2,$3,$4,$5,'LOCAL_DELIVERY','FOOD_DELIVERY','PENDING')",[foodFulfillment,`ful_food_push_${suffix}`,ids.tenant,ids.storeA,foodOrder]);
 const kitchenEvent=await db.query("SELECT category,target_role_keys FROM staff_push_outbox WHERE tenant_id=$1 AND entity_type='kitchen_job' AND category='KITCHEN_NEW_ORDER' ORDER BY created_at DESC LIMIT 1",[ids.tenant]);
 assert.equal(kitchenEvent.rowCount,1,'food fulfillment trigger must enqueue kitchen attention');assert.deepEqual(kitchenEvent.rows[0].target_role_keys,['KITCHEN']);

 console.log('PASS Staff push recipients are tenant/store/role scoped');
 console.log('PASS user/store category preferences suppress delivery');
 console.log('PASS COD reconciliation requires both delivery.manage and payments.manage');
 console.log('PASS OUT_FOR_DELIVERY driver reassignment is blocked server-side');
 console.log('PASS dispatch/kitchen triggers enqueue sanitized advisory push events');
}finally{
 await db.query('DELETE FROM tenants WHERE id=$1',[ids.tenant]).catch(()=>{});await db.query('DELETE FROM tenants WHERE id=$1',[ids.otherTenant]).catch(()=>{});await db.close().catch(()=>{});
}
