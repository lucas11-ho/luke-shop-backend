import fs from 'node:fs';
import assert from 'node:assert/strict';
import { normalizeExperienceConfig } from '../src/modules/customer-experience/service.js';

const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n?/g,'\n');
const pkg=JSON.parse(read('package.json'));
const service=read('src/modules/customer-experience/service.js');
const provisioning=read('src/modules/platform/provisioning.js');
const migration=read('migrations/017_customer_experience_product_detail_schema_v4.sql');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('runtime release remains Backend 0.15.0',()=>assert.equal(pkg.version,'0.15.0'));
test('schema v4 is normalized without changing table shape',()=>{const config=normalizeExperienceConfig({});assert.equal(config.schema_version,4);assert.match(migration,/ALTER COLUMN schema_version SET DEFAULT 4/);assert.doesNotMatch(migration,/ADD COLUMN|DROP COLUMN/i)});
test('historical rows are not mass-backfilled by migration 017',()=>assert.doesNotMatch(migration,/UPDATE\s+storefront_experience_versions/i));
test('Product Detail defaults preserve the 11D live presentation',()=>{const pd=normalizeExperienceConfig({}).product_detail;assert.deepEqual(pd,{gallery_style:'thumbnails',buy_box_style:'sticky',mobile_buy_bar:true,related_products:{enabled:true,limit:4},visibility:{category:true,discount:true,description:true,support:true},info_blocks:['availability','fulfillment','options']})});
test('gallery style is allowlisted',()=>{assert.equal(normalizeExperienceConfig({product_detail:{gallery_style:'stacked'}}).product_detail.gallery_style,'stacked');assert.equal(normalizeExperienceConfig({product_detail:{gallery_style:'unsafe'}}).product_detail.gallery_style,'thumbnails')});
test('buy box style is allowlisted',()=>{assert.equal(normalizeExperienceConfig({product_detail:{buy_box_style:'standard'}}).product_detail.buy_box_style,'standard');assert.equal(normalizeExperienceConfig({product_detail:{buy_box_style:'fixed'}}).product_detail.buy_box_style,'sticky')});
test('mobile buy bar is boolean with backwards-compatible true default',()=>{assert.equal(normalizeExperienceConfig({product_detail:{mobile_buy_bar:false}}).product_detail.mobile_buy_bar,false);assert.equal(normalizeExperienceConfig({product_detail:{}}).product_detail.mobile_buy_bar,true)});
test('related product settings are normalized and limit is clamped 1 through 8',()=>{const low=normalizeExperienceConfig({product_detail:{related_products:{enabled:false,limit:-2}}}).product_detail.related_products;assert.deepEqual(low,{enabled:false,limit:1});const high=normalizeExperienceConfig({product_detail:{related_products:{limit:99}}}).product_detail.related_products;assert.equal(high.limit,8)});
test('visibility contract contains only factual presentation controls',()=>{const pd=normalizeExperienceConfig({product_detail:{visibility:{category:false,discount:false,description:false,support:false,reviews:true}}}).product_detail;assert.deepEqual(pd.visibility,{category:false,discount:false,description:false,support:false});assert.equal('reviews' in pd.visibility,false)});
test('info blocks are allowlisted ordered and de-duplicated',()=>{const pd=normalizeExperienceConfig({product_detail:{info_blocks:['options','availability','options','reviews','fulfillment']}}).product_detail;assert.deepEqual(pd.info_blocks,['options','availability','fulfillment'])});
test('merchant can intentionally hide every info block',()=>assert.deepEqual(normalizeExperienceConfig({product_detail:{info_blocks:[]}}).product_detail.info_blocks,[]));
test('draft save publish rollback persist schema v4 metadata',()=>{for(const marker of ['schema_version=4',",4,$10",",4,$10,now()"] )assert.ok(service.includes(marker),`missing ${marker}`)});
test('new tenant provisioning starts published and draft experiences at schema v4',()=>{assert.match(provisioning,/false,4,now\(\)/);assert.match(provisioning,/false,4\)/)});
test('v4 does not introduce product detail executable markup or arbitrary html fields',()=>{assert.doesNotMatch(service,/product_detail[\s\S]{0,1400}(?:custom_html|script_url|javascript)/i)});

let passed=0;for(const[name,fn]of tests){try{fn();passed++;console.log(`PASS ${name}`)}catch(e){console.error(`FAIL ${name}`);throw e}}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.15.0 CX v4 Product Detail schema checks passed`);
