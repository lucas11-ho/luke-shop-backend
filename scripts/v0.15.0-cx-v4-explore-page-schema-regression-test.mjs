import fs from 'node:fs';
import assert from 'node:assert/strict';
import { normalizeExperienceConfig } from '../src/modules/customer-experience/service.js';

const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n?/g,'\n');
const pkg=JSON.parse(read('package.json'));
const service=read('src/modules/customer-experience/service.js');
const extensions=read('src/modules/customer-experience/extension-normalizer.js');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('runtime release remains Backend 0.15.0',()=>assert.equal(pkg.version,'0.15.0'));
test('Explore defaults reproduce the current live catalog presentation',()=>{const explore=normalizeExperienceConfig({}).explore;assert.deepEqual(explore,{hero_style:'standard',show_result_count:true,show_category_description:false,categories:{enabled:true,style:'rail',show_images:false},page_size:24,load_more_style:'button'})});
test('Explore hero style is allowlisted',()=>{assert.equal(normalizeExperienceConfig({explore:{hero_style:'compact'}}).explore.hero_style,'compact');assert.equal(normalizeExperienceConfig({explore:{hero_style:'minimal'}}).explore.hero_style,'minimal');assert.equal(normalizeExperienceConfig({explore:{hero_style:'scripted'}}).explore.hero_style,'standard')});
test('Explore presentation booleans remain explicit and backwards compatible',()=>{const explore=normalizeExperienceConfig({explore:{show_result_count:false,show_category_description:true,categories:{enabled:false,show_images:true}}}).explore;assert.equal(explore.show_result_count,false);assert.equal(explore.show_category_description,true);assert.equal(explore.categories.enabled,false);assert.equal(explore.categories.show_images,true)});
test('Explore category style is bounded to real renderer variants',()=>{for(const style of ['rail','chips','cards'])assert.equal(normalizeExperienceConfig({explore:{categories:{style}}}).explore.categories.style,style);assert.equal(normalizeExperienceConfig({explore:{categories:{style:'arbitrary'}}}).explore.categories.style,'rail')});
test('Explore page size only permits bounded storefront request sizes',()=>{for(const size of [12,24,36,48])assert.equal(normalizeExperienceConfig({explore:{page_size:size}}).explore.page_size,size);for(const size of [0,13,100,'24x'])assert.equal(normalizeExperienceConfig({explore:{page_size:size}}).explore.page_size,24)});
test('Explore load-more presentation is allowlisted',()=>{assert.equal(normalizeExperienceConfig({explore:{load_more_style:'quiet'}}).explore.load_more_style,'quiet');assert.equal(normalizeExperienceConfig({explore:{load_more_style:'infinite'}}).explore.load_more_style,'button')});
test('Explore contract discards commerce logic and executable fields',()=>{const explore=normalizeExperienceConfig({explore:{sort:'price_desc',price_filter:true,product_type_filter:true,custom_html:'<script>alert(1)</script>',script_url:'https://evil.example/a.js',query_override:'DROP TABLE'}}).explore;for(const key of ['sort','price_filter','product_type_filter','custom_html','script_url','query_override'])assert.equal(key in explore,false)});
test('Explore stays inside the existing Customer Experience contract with no new endpoint',()=>{assert.match(extensions,/function normalizeExplore/);assert.match(extensions,/explore: normalizeExplore\(raw\)/);assert.match(extensions,/EXPLORE_HERO_STYLES/);assert.match(extensions,/EXPLORE_CATEGORY_STYLES/);assert.match(extensions,/EXPLORE_PAGE_SIZES/);assert.doesNotMatch(service,/customer-experience\/explore/)});
test('Explore does not change Customer Experience schema version',()=>assert.equal(normalizeExperienceConfig({explore:{hero_style:'compact'}}).schema_version,4));

let passed=0;for(const[name,fn]of tests){try{fn();passed++;console.log(`PASS ${name}`)}catch(e){console.error(`FAIL ${name}`);throw e}}
console.log(`${passed}/${tests.length} Luke Shop Backend v0.15.0 CX v4 Explore A3 schema checks passed`);
