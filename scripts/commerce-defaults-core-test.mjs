import assert from 'node:assert/strict';
import { ensureStoreCommerceDefaults } from '../src/modules/commerce/defaults.js';

const calls=[];
const client={
  async query(sql,params){
    calls.push({sql,params});
    if(sql.includes("FROM payment_methods")) return {rows:[{code:'MANUAL',status:'ACTIVE'}]};
    if(sql.includes("FROM delivery_methods")) return {rows:[
      {code:'PICKUP',status:'ACTIVE'},
      {code:'SHIPPING',status:'ACTIVE'},
      {code:'LOCAL',status:'ACTIVE'},
    ]};
    return {rows:[],rowCount:1};
  },
};

const result=await ensureStoreCommerceDefaults(client,{tenantId:'tenant-1',storeId:'store-1'});
assert.equal(calls.filter((x)=>x.sql.includes('INSERT INTO payment_methods')).length,1);
assert.equal(calls.filter((x)=>x.sql.includes('INSERT INTO delivery_methods')).length,3);
assert.ok(calls.filter((x)=>x.sql.includes('INSERT INTO')).every((x)=>x.sql.includes('ON CONFLICT (tenant_id,store_id,code) DO NOTHING')));
assert.equal(result.paymentMethods[0].code,'MANUAL');
assert.deepEqual(result.deliveryMethods.map((x)=>x.code),['PICKUP','SHIPPING','LOCAL']);
console.log('PASS shared commerce defaults are deterministic and idempotent by tenant/store/code');
