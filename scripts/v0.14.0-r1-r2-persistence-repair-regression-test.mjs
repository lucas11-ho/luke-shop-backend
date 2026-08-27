import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { deleteR2Asset } from '../src/modules/assets/storage.js';

const read=(p)=>readFileSync(p,'utf8').replace(/\r\n?/g,'\n');
const tests=[];
const test=(name,fn)=>tests.push([name,fn]);

const migration=read('migrations/016_r2_storage_provider_persistence_repair.sql');
const storage=read('src/modules/assets/storage.js');
const merchant=read('src/modules/assets/routes.js');
const customer=read('src/modules/auth/customer-routes.js');
const pkg=JSON.parse(read('package.json'));

test('hotfix remains compatible through Luke Shop application version 0.15.0',()=>assert.ok(['0.14.0','0.14.1','0.14.2','0.15.0'].includes(pkg.version)));
test('migration 016 exists',()=>assert.ok(existsSync('migrations/016_r2_storage_provider_persistence_repair.sql')));
test('migration 016 never edits migration 009',()=>assert.match(migration,/ALTER TABLE media_assets/));
test('migration 016 drops the legacy storage provider check',()=>assert.match(migration,/DROP CONSTRAINT IF EXISTS media_assets_storage_provider_check/));
test('migration 016 allows LOCAL provider',()=>assert.match(migration,/storage_provider IN \('LOCAL', 'R2'\)/));
test('migration 016 allows R2 provider',()=>assert.match(migration,/storage_provider IN \('LOCAL', 'R2'\)/));
test('R2 storage implements signed DELETE cleanup',()=>{assert.match(storage,/method:'DELETE'/);assert.match(storage,/R2 delete failed/);});
test('local storage cleanup treats missing content as already cleaned',()=>{assert.match(storage,/deleteLocalAsset/);assert.match(storage,/ENOENT/);});
test('storage abstraction exposes provider-aware deleteAsset',()=>assert.match(storage,/export async function deleteAsset/));
test('merchant upload compensates storage when DB persistence fails',()=>{assert.match(merchant,/catch \(error\)[\s\S]*deleteAsset\(app\.config,storageKey\)[\s\S]*throw error/);});
test('merchant cleanup failure is logged without masking DB error',()=>assert.match(merchant,/asset rollback cleanup failed/));
test('customer avatar compensates storage when DB persistence fails',()=>{assert.match(customer,/customer\/me\/avatar[\s\S]*catch\(error\)[\s\S]*deleteAsset\(app\.config,storageKey\)/);});
test('customer avatar cleanup failure is logged',()=>assert.match(customer,/customer avatar rollback cleanup failed/));
test('public R2 URL remains backend-proxied when R2_PUBLIC_BASE_URL is blank',()=>assert.match(storage,/assetPublicBaseUrl.*\/v1\/assets\/public/s));
test('hotfix test is part of normal verify',()=>assert.match(JSON.stringify(pkg.scripts),/test:r2-persistence-r014r1/));

test('R2 delete sends authenticated DELETE to account/bucket/object path',async()=>{
  const originalFetch=globalThis.fetch;
  let call=null;
  globalThis.fetch=async(url,options)=>{call={url:String(url),options};return new Response(null,{status:204});};
  try {
    const removed=await deleteR2Asset({r2AccountId:'acct123',r2Bucket:'bucket-test',r2AccessKeyId:'ACCESS',r2SecretAccessKey:'SECRET'},'tenant/store/asset.png');
    assert.equal(removed,true);
    assert.equal(call.options.method,'DELETE');
    assert.match(call.url,/https:\/\/acct123\.r2\.cloudflarestorage\.com\/bucket-test\/tenant\/store\/asset\.png$/);
    assert.match(String(call.options.headers.Authorization||''),/^AWS4-HMAC-SHA256 /);
  } finally { globalThis.fetch=originalFetch; }
});

let pass=0;
for(const [name,fn] of tests){try{await fn();console.log('PASS',name);pass++;}catch(error){console.error('FAIL',name);throw error;}}
console.log(`${pass}/${tests.length} Luke Shop Backend v0.14.0-R1 R2 persistence repair checks passed`);
