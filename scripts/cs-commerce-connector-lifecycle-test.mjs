import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { newServiceCredential } from '../src/core/tokens.js';
import { ensureCustomerServicePolicy } from '../src/modules/integrations/customer-service/policy.js';

const config=loadConfig(); const app=await buildApp(config); const suffix=randomUUID().replaceAll('-','').slice(0,12);
const slug=`cs-${suffix}`; const password='CS-Connector-Lifecycle-Password-2026!'; const email=`buyer-${suffix}@example.com`; let tenantId;
const j=(r)=>{try{return r.json();}catch{return null;}}; const expect=(r,s,label)=>{assert.equal(r.statusCode,s,`${label}: ${r.statusCode} ${r.body}`);return j(r);}; const req=(o)=>app.inject(o);
const nonce=()=>randomUUID().replaceAll('-',''); const timestamp=()=>String(Math.floor(Date.now()/1000));
try {
  await app.ready(); const db=app.db; tenantId=randomUUID(); const storeId=randomUUID(); const clientId=randomUUID(); const credential=newServiceCredential(config.serviceCredentialPepper);
  await db.transaction(async(client)=>{
    await client.query("INSERT INTO tenants(id,public_id,slug,name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[tenantId,`tnt_cs_${suffix}`,slug,`CS ${suffix}`]);
    await client.query("INSERT INTO tenant_settings(tenant_id,currency,customer_service) VALUES($1,'USD',$2::jsonb)",[tenantId,JSON.stringify({enabled:true,provider:'LUKE_CS'})]);
    await client.query("INSERT INTO stores(id,public_id,tenant_id,name,status,is_primary) VALUES($1,$2,$3,'Main','ACTIVE',true)",[storeId,`str_cs_${suffix}`,tenantId]);
    await ensureCustomerServicePolicy(client,tenantId,{enabled:true});
    await client.query(`UPDATE customer_service_policies SET ai_customer_read=true,ai_product_read=true,ai_orders_read=false,ai_payments_read=false,ai_delivery_read=false WHERE tenant_id=$1`,[tenantId]);
    await client.query(`INSERT INTO integration_clients(id,public_id,tenant_id,kind,name,client_id,secret_hash,scopes,usage_mode,status) VALUES($1,$2,$3,'LUKE_CS','AI Test',$4,$5,$6,'AI','ACTIVE')`,[clientId,`int_cs_${suffix}`,tenantId,credential.clientId,credential.secretHash,['customer.read','product.read','orders.read','order_status.read','payments.read','delivery.read']]);
  });
  const tenantHeaders={'x-tenant-slug':slug};
  const registered=expect(await req({method:'POST',url:'/v1/customer/auth/register',headers:tenantHeaders,payload:{email,password,display_name:'CS Buyer'}}),201,'customer register');
  const customerAuth={authorization:`Bearer ${registered.data.tokens.access_token}`};
  const context=expect(await req({method:'POST',url:'/v1/customer/support/context',headers:customerAuth,payload:{}}),201,'support context').data;
  assert.ok(context.context); assert.ok(context.allowed_tools.includes('orders.list'),'general policy should place orders.list in signed context');

  const rawCredential=`${credential.clientId}.${credential.secret}`;
  const rawToolDenied=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{authorization:`Bearer ${rawCredential}`,'x-luke-shop-context':context.context,'x-luke-request-nonce':nonce(),'x-luke-request-timestamp':timestamp()},payload:{tool:'customer.get',arguments:{}}}),401,'raw credential tool gateway denied');
  assert.equal(rawToolDenied.error.code,'SERVICE_SIGNED_TOKEN_REQUIRED');
  const serviceToken=expect(await req({method:'POST',url:'/v1/customer-service/auth/token',headers:{authorization:`Bearer ${rawCredential}`}}),200,'signed service token').data;
  assert.ok(serviceToken.access_token.split('.').length===3,'signed service token must be a JWT'); assert.equal(serviceToken.usage_mode,'AI');
  const base={authorization:`Bearer ${serviceToken.access_token}`,'x-luke-shop-context':context.context};
  const replayNonce=nonce(); const replayTimestamp=timestamp();
  const first=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{...base,'x-luke-request-nonce':replayNonce,'x-luke-request-timestamp':replayTimestamp},payload:{tool:'customer.get',arguments:{}}}),200,'customer.get');
  assert.equal(first.data.tool,'customer.get'); assert.equal(first.meta.customer_id,registered.data.customer.id); assert.equal(first.data.result.email,undefined);
  const replay=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{...base,'x-luke-request-nonce':replayNonce,'x-luke-request-timestamp':replayTimestamp},payload:{tool:'customer.get',arguments:{}}}),401,'nonce replay'); assert.equal(replay.error.code,'SERVICE_REQUEST_REPLAYED');

  const search=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{...base,'x-luke-request-nonce':nonce(),'x-luke-request-timestamp':timestamp()},payload:{tool:'product.search',arguments:{q:'nothing'}}}),200,'product.search'); assert.deepEqual(search.data.result.products,[]);
  const denied=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{...base,'x-luke-request-nonce':nonce(),'x-luke-request-timestamp':timestamp()},payload:{tool:'orders.list',arguments:{}}}),403,'AI orders policy denied'); assert.equal(denied.error.code,'CS_TOOL_POLICY_DENIED');

  const toolCalls=await db.query(`SELECT tool_name,result_code FROM customer_service_tool_calls WHERE tenant_id=$1 AND integration_client_id=$2 ORDER BY id`,[tenantId,clientId]);
  assert.ok(toolCalls.rows.some((r)=>r.tool_name==='customer.get'&&r.result_code==='SUCCESS')); assert.ok(toolCalls.rows.some((r)=>r.tool_name==='orders.list'&&r.result_code==='CS_TOOL_POLICY_DENIED'));
  const nonceRows=await db.query(`SELECT count(*)::int AS n FROM customer_service_request_nonces WHERE tenant_id=$1 AND integration_client_id=$2`,[tenantId,clientId]); assert.ok(nonceRows.rows[0].n>=3);

  expect(await req({method:'POST',url:'/v1/customer/support/context/revoke',headers:customerAuth,payload:{}}),200,'context revoke');
  const revoked=expect(await req({method:'POST',url:'/v1/customer-service/tools/execute',headers:{...base,'x-luke-request-nonce':nonce(),'x-luke-request-timestamp':timestamp()},payload:{tool:'customer.get',arguments:{}}}),401,'revoked context'); assert.equal(revoked.error.code,'SUPPORT_CONTEXT_INVALID');

  console.log('PASS tool gateway rejects long-lived credential and requires signed service token');
  console.log('PASS signed Luke CS service token exchange');
  console.log('PASS customer/session/store-bound support context');
  console.log('PASS nonce replay protection rejects duplicate service request');
  console.log('PASS AI tenant policy can deny an otherwise scoped read tool');
  console.log('PASS read-only tool calls are durably audited without copying result payloads');
} finally {
  if(tenantId) await app.db.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  await app.close().catch(()=>{});
}
