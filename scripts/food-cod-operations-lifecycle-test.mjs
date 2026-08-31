import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/core/passwords.js';
import { ALL_PERMISSIONS } from '../src/core/permissions.js';
import { ensureStoreCommerceDefaults } from '../src/modules/commerce/defaults.js';

const config=loadConfig();
const app=await buildApp(config);
const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`food-cod-${suffix}`;
const password='Food-COD-Operations-2026!';
const ownerEmail=`owner-${suffix}@example.com`;
const customerEmail=`buyer-${suffix}@example.com`;
let tenantId;

const json=r=>{try{return r.json();}catch{return null;}};
const expect=(r,status,label)=>{assert.equal(r.statusCode,status,`${label}: ${r.statusCode} ${r.body}`);return json(r);};
const req=o=>app.inject(o);
const authHeader=token=>({authorization:`Bearer ${token}`});

try{
  await app.ready();
  const db=app.db;
  tenantId=randomUUID();
  const storeId=randomUUID(),ownerId=randomUUID(),ownerRoleId=randomUUID();
  const passwordHash=await hashPassword(password);

  await db.transaction(async client=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_foodcod_${suffix}`,slug,`Food COD ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency,timezone) VALUES($1,'USD','UTC')",[tenantId]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_foodcod_${suffix}`,tenantId]);
    await client.query("INSERT INTO inventory_locations(id,public_id,tenant_id,store_id,code,name,status,is_default) VALUES($1,$2,$3,$4,'MAIN','Main Inventory','ACTIVE',true)",[randomUUID(),`loc_foodcod_${suffix}`,tenantId,storeId]);
    await ensureStoreCommerceDefaults(client,{tenantId,storeId});
    await client.query("INSERT INTO merchant_users(id,public_id,tenant_id,email,password_hash,display_name,status,password_changed_at) VALUES($1,$2,$3,$4,$5,'Owner','ACTIVE',now())",[ownerId,`musr_owner_${suffix}`,tenantId,ownerEmail,passwordHash]);
    await client.query("INSERT INTO merchant_roles(id,tenant_id,key,name,is_system) VALUES($1,$2,'OWNER','Owner',true)",[ownerRoleId,tenantId]);
    for(const permission of ALL_PERMISSIONS)await client.query('INSERT INTO merchant_role_permissions(role_id,permission_key) VALUES($1,$2)',[ownerRoleId,permission]);
    await client.query('INSERT INTO merchant_user_roles(tenant_id,merchant_user_id,role_id) VALUES($1,$2,$3)',[tenantId,ownerId,ownerRoleId]);
  });

  const tenantHeaders={'x-tenant-slug':slug};
  const ownerLogin=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email:ownerEmail,password}}),200,'owner login');
  const ownerAuth=authHeader(ownerLogin.data.tokens.access_token);

  const roles=expect(await req({method:'GET',url:'/v1/merchant/roles',headers:ownerAuth}),200,'read operational roles').data.roles;
  const roleByKey=key=>{const role=roles.find(r=>r.key===key);assert.ok(role?.id,`missing ${key} role`);return role;};
  const createStaff=async(key,label)=>{
    const role=roleByKey(key),email=`${key.toLowerCase()}-${suffix}@example.com`;
    const staff=expect(await req({method:'POST',url:'/v1/merchant/staff',headers:ownerAuth,payload:{email,password,display_name:label,role_ids:[role.id]}}),201,`create ${key} staff`).data.staff;
    const login=expect(await req({method:'POST',url:'/v1/merchant/auth/login',headers:tenantHeaders,payload:{email,password}}),200,`${key} login`);
    return {staff,auth:authHeader(login.data.tokens.access_token)};
  };
  const kitchen=await createStaff('KITCHEN','Kitchen Test');
  const cashier=await createStaff('CASHIER','Cashier Test');
  const dispatcher=await createStaff('DISPATCHER','Dispatcher Test');
  const driverUser=await createStaff('DRIVER','Driver Test');

  expect(await req({method:'PUT',url:'/v1/merchant/delivery/settings',headers:ownerAuth,payload:{delivery_enabled:true,enforce_operating_hours:false,require_ready_before_dispatch:true,kitchen_enabled:true,cashier_enabled:true,kitchen_payment_policy:'PAID_OR_COD'}}),200,'enable strict delivery operations policy');

  const driver=expect(await req({method:'POST',url:'/v1/merchant/delivery/drivers',headers:ownerAuth,payload:{display_name:'Driver Test',status:'ACTIVE',vehicle_type:'MOTORBIKE',vehicle_label:'CI-01',merchant_user_id:driverUser.staff.id}}),201,'link driver identity').data.driver;
  expect(await req({method:'GET',url:'/v1/driver/me',headers:driverUser.auth}),200,'driver scoped identity');
  const broadDriverDenied=expect(await req({method:'GET',url:'/v1/merchant/delivery/dispatches',headers:driverUser.auth}),403,'driver broad merchant delivery denied');
  assert.equal(broadDriverDenied.error.code,'PERMISSION_REQUIRED');

  const codMethod=expect(await req({method:'POST',url:'/v1/merchant/payment-methods',headers:ownerAuth,payload:{code:`COD_${suffix}`,name:'Cash on delivery',provider_type:'CASH_ON_DELIVERY',status:'ACTIVE',sort_order:5}}),201,'create COD payment method').data.payment_method;
  const product=expect(await req({method:'POST',url:'/v1/merchant/products',headers:ownerAuth,payload:{name:'Kitchen Meal',slug:`kitchen-meal-${suffix}`,product_type:'FOOD',status:'PUBLISHED',base_price:12.5,fulfillment_modes:['LOCAL_DELIVERY','PICKUP'],track_inventory:true,sku:`MEAL-${suffix}`}}),201,'create food product').data.product;
  const inventory=expect(await req({method:'GET',url:'/v1/merchant/inventory',headers:ownerAuth}),200,'inventory list').data.inventory;
  const item=inventory.find(row=>row.product_id===product.public_id&&row.variant_id===null);assert.ok(item,'food inventory item missing');
  expect(await req({method:'POST',url:'/v1/merchant/inventory/adjustments',headers:ownerAuth,payload:{inventory_item_id:item.inventory_item_id,movement_type:'RECEIVE',quantity:20,reason:'FOOD COD lifecycle stock'}}),201,'receive food stock');

  const customer=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email:customerEmail,password,display_name:'Food COD Buyer'}}),201,'customer register');
  const customerAuth=authHeader(customer.data.tokens.access_token);
  expect(await req({method:'POST',url:'/v1/customer/cart/items',headers:customerAuth,payload:{product_id:product.public_id,quantity:2,fulfillment_mode:'LOCAL_DELIVERY'}}),201,'add food delivery item');
  const checkout=expect(await req({method:'POST',url:'/v1/customer/checkout',headers:customerAuth,payload:{idempotency_key:`food-cod-${suffix}`,payment_method_id:codMethod.id,shipping_address:{recipient_name:'Food COD Buyer',phone:'+85510000000',country_code:'KH',city:'Phnom Penh',address_line_1:'1 Operations Test Road'}}}),201,'FOOD COD checkout');
  const order=checkout.data.order;
  assert.equal(order.status,'PENDING_PAYMENT');assert.equal(order.payment_status,'PENDING');

  const dbOrder=(await db.query(`SELECT o.id,o.public_id,o.order_number,o.status,o.payment_status,o.reservation_expires_at,op.status AS payment_record_status,op.amount AS payment_amount,f.public_id AS fulfillment_id,f.fulfillment_type,f.status AS fulfillment_status,j.public_id AS kitchen_job_id,j.status AS kitchen_status FROM orders o JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id JOIN order_fulfillments f ON f.order_id=o.id AND f.tenant_id=o.tenant_id AND f.store_id=o.store_id JOIN kitchen_jobs j ON j.fulfillment_id=f.id AND j.tenant_id=f.tenant_id AND j.store_id=f.store_id WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.public_id=$3`,[tenantId,storeId,order.id])).rows[0];
  assert.ok(dbOrder,'FOOD COD order database state missing');
  assert.equal(dbOrder.fulfillment_type,'FOOD_DELIVERY');assert.equal(dbOrder.fulfillment_status,'PENDING');assert.equal(dbOrder.kitchen_status,'NEW');assert.equal(dbOrder.payment_record_status,'PENDING');assert.equal(dbOrder.reservation_expires_at,null);

  const queue=expect(await req({method:'GET',url:'/v1/merchant/kitchen/queue',headers:kitchen.auth}),200,'kitchen queue').data.jobs;
  const job=queue.find(row=>row.id===dbOrder.kitchen_job_id);assert.ok(job,'kitchen job not visible to Kitchen role');assert.equal(job.payment_ready,true);assert.equal(job.provider_type,'CASH_ON_DELIVERY');

  const earlyDispatch=await req({method:'POST',url:'/v1/merchant/delivery/dispatches',headers:dispatcher.auth,payload:{fulfillment_id:dbOrder.fulfillment_id,driver_id:driver.id,notes:'Must be rejected before READY'}});
  assert.notEqual(earlyDispatch.statusCode,201,`pre-READY dispatch unexpectedly succeeded: ${earlyDispatch.body}`);

  for(const status of ['ACCEPTED','PREPARING','READY']){
    const moved=expect(await req({method:'POST',url:`/v1/merchant/kitchen/jobs/${dbOrder.kitchen_job_id}/transition`,headers:kitchen.auth,payload:{status,note:`CI ${status}`}}),200,`kitchen ${status}`).data.job;
    assert.equal(moved.status,status);
  }
  let financial=(await db.query('SELECT o.status,o.payment_status,op.status AS payment_record_status,f.status AS fulfillment_status FROM orders o JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id JOIN order_fulfillments f ON f.order_id=o.id AND f.tenant_id=o.tenant_id AND f.store_id=o.store_id WHERE o.id=$1',[dbOrder.id])).rows[0];
  assert.equal(financial.payment_status,'PENDING');assert.equal(financial.payment_record_status,'PENDING');assert.equal(financial.fulfillment_status,'READY');

  const dispatch=expect(await req({method:'POST',url:'/v1/merchant/delivery/dispatches',headers:dispatcher.auth,payload:{fulfillment_id:dbOrder.fulfillment_id,driver_id:driver.id,notes:'Ready for driver'}}),201,'dispatch after READY').data.dispatch;
  for(const status of ['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY']){
    const moved=expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/status`,headers:driverUser.auth,payload:{status}}),200,`driver ${status}`).data.dispatch;
    assert.equal(moved.status,status);
  }

  const expectedAmount=Number(dbOrder.payment_amount);
  const mismatch=expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/cod/collect`,headers:driverUser.auth,payload:{amount:expectedAmount+1,note:'Wrong amount test'}}),409,'reject wrong COD amount');assert.equal(mismatch.error.code,'COD_AMOUNT_MISMATCH');
  const collection=expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/cod/collect`,headers:driverUser.auth,payload:{amount:expectedAmount,note:'Exact cash collected'}}),201,'collect exact COD').data.collection;
  assert.equal(collection.status,'COLLECTED');
  financial=(await db.query('SELECT o.payment_status,op.status AS payment_record_status FROM orders o JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id WHERE o.id=$1',[dbOrder.id])).rows[0];assert.equal(financial.payment_status,'PENDING');assert.equal(financial.payment_record_status,'PENDING');

  const noProof=expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/status`,headers:driverUser.auth,payload:{status:'DELIVERED'}}),409,'delivery proof required');assert.equal(noProof.error.code,'DELIVERY_PROOF_REQUIRED');
  expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/proofs`,headers:driverUser.auth,payload:{recipient_name:'Food COD Buyer',note:'Recipient acknowledged delivery'}}),201,'add delivery acknowledgement');
  const delivered=expect(await req({method:'POST',url:`/v1/driver/dispatches/${dispatch.id}/status`,headers:driverUser.auth,payload:{status:'DELIVERED'}}),200,'driver delivered').data.dispatch;
  assert.equal(delivered.status,'DELIVERED');assert.equal(delivered.fulfillment.status,'DELIVERED');assert.equal(delivered.payment.status,'PENDING');

  const cashierQueue=expect(await req({method:'GET',url:'/v1/merchant/cashier/queue',headers:cashier.auth}),200,'cashier queue').data.orders;
  const cashierOrder=cashierQueue.find(row=>row.order_number===dbOrder.order_number);assert.ok(cashierOrder,'COD order not visible to Cashier role');assert.equal(cashierOrder.can_receive_cod,true);
  const remitted=expect(await req({method:'POST',url:`/v1/merchant/cashier/cod/${collection.id}/receive`,headers:cashier.auth,payload:{reference:`RCPT-${suffix}`,note:'Cash physically received from driver'}}),200,'cashier receives driver cash').data.collection;
  assert.equal(remitted.status,'REMITTED');
  financial=(await db.query('SELECT o.payment_status,op.status AS payment_record_status FROM orders o JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id WHERE o.id=$1',[dbOrder.id])).rows[0];assert.equal(financial.payment_status,'PENDING');assert.equal(financial.payment_record_status,'PENDING');

  const cashierReconcile=expect(await req({method:'POST',url:`/v1/merchant/delivery/cod/${collection.id}/reconcile`,headers:cashier.auth,payload:{note:'Cashier must not reconcile'}}),403,'Cashier final reconciliation denied');assert.equal(cashierReconcile.error.code,'PERMISSION_REQUIRED');
  const reconciled=expect(await req({method:'POST',url:`/v1/merchant/delivery/cod/${collection.id}/reconcile`,headers:ownerAuth,payload:{note:'Owner/accounting reconciliation complete'}}),200,'Owner reconciles COD').data.collection;
  assert.equal(reconciled.status,'RECONCILED');assert.equal(reconciled.payment_record_status,'PAID');assert.equal(reconciled.payment_status,'PAID');

  financial=(await db.query('SELECT o.status,o.payment_status,op.status AS payment_record_status,f.status AS fulfillment_status,c.status AS cod_status FROM orders o JOIN order_payments op ON op.order_id=o.id AND op.tenant_id=o.tenant_id AND op.store_id=o.store_id JOIN order_fulfillments f ON f.order_id=o.id AND f.tenant_id=o.tenant_id AND f.store_id=o.store_id JOIN delivery_cod_collections c ON c.order_id=o.id AND c.tenant_id=o.tenant_id AND c.store_id=o.store_id WHERE o.id=$1',[dbOrder.id])).rows[0];
  assert.equal(financial.payment_status,'PAID');assert.equal(financial.payment_record_status,'PAID');assert.equal(financial.fulfillment_status,'DELIVERED');assert.equal(financial.cod_status,'RECONCILED');

  const audits=await db.query("SELECT action FROM audit_logs WHERE tenant_id=$1 AND action = ANY($2::text[])",[tenantId,['kitchen.job.transition','delivery.dispatch.assign','delivery.driver.status','delivery.cod.collect','cashier.cod.receive','delivery.cod.reconcile']]);
  const actions=new Set(audits.rows.map(row=>row.action));
  for(const action of ['kitchen.job.transition','delivery.dispatch.assign','delivery.driver.status','delivery.cod.collect','cashier.cod.receive','delivery.cod.reconcile'])assert.ok(actions.has(action),`missing audit ${action}`);

  console.log('PASS FOOD + COD checkout creates an unpaid Kitchen job and durable COD reservation');
  console.log('PASS Kitchen prepares COD without fake payment settlement and READY gates dispatch');
  console.log('PASS assignment-scoped Driver lifecycle requires exact COD amount and delivery proof');
  console.log('PASS Driver collection and Cashier receipt preserve PENDING payment state');
  console.log('PASS Cashier cannot reconcile and Owner authority settles COD + payment atomically');
  console.log('PASS end-to-end operational audit trail is durable in PostgreSQL');
} finally {
  if(tenantId)await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  await app.close().catch(()=>{});
}
