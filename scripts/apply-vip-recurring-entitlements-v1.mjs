import fs from'node:fs';

function read(path){return fs.readFileSync(path,'utf8')}
function write(path,value){fs.writeFileSync(path,value)}
function mustReplace(source,from,to,label){if(!source.includes(from))throw new Error(`Patch target missing: ${label}`);return source.replace(from,to)}

// Reuse the existing entitlement writer so order-driven and recurring issuance share one durable table/idempotency boundary.
{
 const path='src/modules/loyalty/execution.js';let s=read(path);
 s=mustReplace(s,'async function createEntitlement(client,{tenantId,storeId,customerId,levelId,benefitId,orderId,type,config,issuanceKey}){','export async function createVipEntitlement(client,{tenantId,storeId,customerId,levelId,benefitId,orderId,type,config,issuanceKey}){','export entitlement writer');
 s=s.replaceAll('createEntitlement(client,{','createVipEntitlement(client,{');
 write(path,s);
}

// Enforce that non-order frequencies are entitlement-only instead of silently accepting unsupported cashback/free-delivery schedules.
{
 const path='src/modules/loyalty/merchant-routes.js';let s=read(path);
 s=mustReplace(s,"import { evaluateCustomerVip, getVipProgram, listVipBenefits, listVipLevels, normalizeBenefitConfig, validateVipLevel, vipMemberDetail, vipOverview } from './service.js';", "import { evaluateCustomerVip, getVipProgram, listVipBenefits, listVipLevels, normalizeBenefitConfig, validateVipLevel, vipMemberDetail, vipOverview } from './service.js';\nimport { assertVipBenefitFrequency } from './issuance.js';",'merchant issuance import');
 s=mustReplace(s,"const config=normalizeBenefitConfig(request.body.benefit_type,request.body.config),id=uuid(),pid=publicId('vipb');", "assertVipBenefitFrequency(request.body.benefit_type,request.body.frequency);const config=normalizeBenefitConfig(request.body.benefit_type,request.body.config),id=uuid(),pid=publicId('vipb');",'create benefit frequency validation');
 s=mustReplace(s,"const c=r.rows[0],b=request.body,type=b.benefit_type??c.benefit_type,config=b.config!==undefined?normalizeBenefitConfig(type,b.config):c.config;await app.db.query(`UPDATE vip_benefits SET name=$1,benefit_type=$2,frequency=$3,status=$4,config=$5::jsonb,sort_order=$6,updated_at=now() WHERE id=$7`,[b.name?.trim()??c.name,type,b.frequency??c.frequency,b.status??c.status,JSON.stringify(config),b.sort_order??c.sort_order,c.id]);", "const c=r.rows[0],b=request.body,type=b.benefit_type??c.benefit_type,frequency=b.frequency??c.frequency;assertVipBenefitFrequency(type,frequency);const config=b.config!==undefined?normalizeBenefitConfig(type,b.config):c.config;await app.db.query(`UPDATE vip_benefits SET name=$1,benefit_type=$2,frequency=$3,status=$4,config=$5::jsonb,sort_order=$6,updated_at=now() WHERE id=$7`,[b.name?.trim()??c.name,type,frequency,b.status??c.status,JSON.stringify(config),b.sort_order??c.sort_order,c.id]);",'update benefit frequency validation');
 s=s.replace('SELECT c.public_id AS customer_id,c.customer_code,c.display_name,c.email,c.phone_e164,c.status AS customer_status,','SELECT c.public_id AS customer_id,c.customer_code,c.display_name,c.email,c.phone_e164,c.birth_date,c.status AS customer_status,');
 write(path,s);
}

// Merchant policy, controlled runner, and retry-safe manual entitlement issue endpoints.
{
 const path='src/modules/loyalty/execution-routes.js';let s=read(path);
 s=mustReplace(s,"import { vipCashbackRedemptionPolicy } from './redemption.js';", "import { vipCashbackRedemptionPolicy } from './redemption.js';\nimport { issueManualVipEntitlement, recurringVipIssuancePolicy, runRecurringVipEntitlements } from './issuance.js';",'execution issuance import');
 const marker="  app.get('/v1/merchant/vip/members/:customerRef/rewards',{preHandler:readGuard(app)},async request=>{";
 const routes=`  app.get('/v1/merchant/vip/issuance-policy',{preHandler:readGuard(app)},async request=>{\n    const store=await merchantStore(app,request),policy=await recurringVipIssuancePolicy(app.db,{tenantId:request.auth.tenantId,storeId:store.id});\n    return {data:{store:{id:store.public_id,name:store.name},policy}};\n  });\n\n  app.put('/v1/merchant/vip/issuance-policy',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['recurring_entitlement_issuance_enabled'],properties:{recurring_entitlement_issuance_enabled:{type:'boolean'}}}}},async request=>{\n    const store=await merchantStore(app,request),tenantId=request.auth.tenantId,enabled=request.body.recurring_entitlement_issuance_enabled;let policy;\n    await app.db.transaction(async client=>{\n      const current=await client.query(\`SELECT id,recurring_entitlement_issuance_enabled FROM vip_programs WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE\`,[tenantId,store.id]);\n      if(!current.rowCount)throw errors.notFound('VIP_PROGRAM_NOT_FOUND','VIP program not found');\n      const was=!!current.rows[0].recurring_entitlement_issuance_enabled;\n      await client.query(\`UPDATE vip_programs SET recurring_entitlement_issuance_enabled=$1,recurring_entitlement_issuance_enabled_at=CASE WHEN $1=true AND $2=false THEN now() WHEN $1=true THEN recurring_entitlement_issuance_enabled_at ELSE NULL END,updated_at=now() WHERE tenant_id=$3 AND store_id=$4\`,[enabled,was,tenantId,store.id]);\n      policy=await recurringVipIssuancePolicy(client,{tenantId,storeId:store.id});\n      await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.recurring_entitlements.policy.update',targetType:'vip_program',targetId:current.rows[0].id,metadata:{recurring_entitlement_issuance_enabled:enabled,effective:policy.enabled},requestIp:request.ip,requestId:request.id});\n    });\n    return {data:{policy}};\n  });\n\n  app.post('/v1/merchant/vip/issuance/run',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:5000}}}}},async request=>{\n    const store=await merchantStore(app,request),tenantId=request.auth.tenantId;let summary;\n    await app.db.transaction(async client=>{summary=await runRecurringVipEntitlements(client,{tenantId,storeId:store.id,limit:request.body?.limit||5000});await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.recurring_entitlements.run',targetType:'store',targetId:store.id,metadata:summary,requestIp:request.ip,requestId:request.id});});\n    return {data:{summary}};\n  });\n\n  app.post('/v1/merchant/vip/members/:customerRef/entitlements/issue',{preHandler:manageGuard(app),schema:{body:{type:'object',additionalProperties:false,required:['benefit_id','request_key','reason'],properties:{benefit_id:{type:'string',minLength:1,maxLength:120},request_key:{type:'string',minLength:8,maxLength:120,pattern:'^[A-Za-z0-9._:-]+$'},reason:{type:'string',minLength:3,maxLength:1000}}}}},async request=>{\n    const store=await merchantStore(app,request),tenantId=request.auth.tenantId,customer=await customerByRef(app.db,tenantId,request.params.customerRef);let result;\n    await app.db.transaction(async client=>{result=await issueManualVipEntitlement(client,{tenantId,storeId:store.id,customerId:customer.id,benefitRef:request.body.benefit_id,requestKey:request.body.request_key,reason:request.body.reason});await writeAudit(client,{tenantId,actorType:'MERCHANT',actorId:request.auth.actorId,action:'vip.manual_entitlement.issue',targetType:'customer',targetId:customer.id,metadata:{benefit_id:request.body.benefit_id,request_key:request.body.request_key,reason:request.body.reason,created:result.created},requestIp:request.ip,requestId:request.id});});\n    return {data:{customer:{id:customer.public_id,customer_code:customer.customer_code,display_name:customer.display_name},...result}};\n  });\n\n`;
 s=mustReplace(s,marker,routes+marker,'merchant issuance routes');
 write(path,s);
}

// Birthday is customer-owned profile data, not inferred from orders or identity providers.
{
 const path='src/modules/auth/customer-identity.js';let s=read(path);
 s=mustReplace(s,"export function publicCustomer(row){return {id:row.public_id,customer_code:row.customer_code||row.public_id,display_name:row.display_name,email:row.email||null,phone_e164:row.phone_e164||null,avatar_url:row.avatar_url||null,status:row.status};}", "export function publicCustomer(row){return {id:row.public_id,customer_code:row.customer_code||row.public_id,display_name:row.display_name,email:row.email||null,phone_e164:row.phone_e164||null,avatar_url:row.avatar_url||null,birth_date:row.birth_date||null,status:row.status};}",'public customer birth date');
 write(path,s);
}
{
 const path='src/modules/auth/customer-routes.js';let s=read(path);
 s=s.replace('SELECT id, public_id, customer_code, email, phone_e164, avatar_url, display_name, status, password_hash','SELECT id, public_id, customer_code, email, phone_e164, avatar_url, birth_date, display_name, status, password_hash');
 const start=s.indexOf("  app.patch('/v1/customer/me', {");const end=s.indexOf("  app.post('/v1/customer/me/change-password'",start);if(start<0||end<0)throw new Error('Patch target missing: customer me route');
 const replacement=`  app.patch('/v1/customer/me', {\n    preHandler: [app.requireCustomerAuth],\n    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {\n      display_name: { type: 'string', minLength: 1, maxLength: 100 },\n      birth_date: { type: ['string','null'], format: 'date' },\n    } } },\n  }, async (request) => app.db.transaction(async (client) => {\n    const current=await client.query('SELECT display_name,birth_date FROM customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[request.auth.tenantId,request.auth.actorId]);\n    if(!current.rowCount)throw errors.notFound('CUSTOMER_NOT_FOUND','Customer not found');\n    const hasName=Object.prototype.hasOwnProperty.call(request.body,'display_name'),hasBirth=Object.prototype.hasOwnProperty.call(request.body,'birth_date');\n    const displayName=hasName?request.body.display_name.trim():current.rows[0].display_name;\n    const birthDate=hasBirth?request.body.birth_date:current.rows[0].birth_date;\n    if(birthDate&&birthDate< '1900-01-01')throw errors.badRequest('CUSTOMER_BIRTH_DATE_INVALID','Birth date must be on or after 1900-01-01');\n    if(birthDate&&birthDate>new Date().toISOString().slice(0,10))throw errors.badRequest('CUSTOMER_BIRTH_DATE_INVALID','Birth date cannot be in the future');\n    const updated = await client.query(\n      \`UPDATE customers SET display_name=$1,birth_date=$2,updated_at=now()\n        WHERE tenant_id=$3 AND id=$4 RETURNING public_id,customer_code,email,phone_e164,avatar_url,birth_date,display_name,status\`,\n      [displayName,birthDate||null,request.auth.tenantId,request.auth.actorId],\n    );\n    const changedFields=[];if(hasName)changedFields.push('display_name');if(hasBirth)changedFields.push('birth_date');\n    await writeAudit(client, { tenantId: request.auth.tenantId, actorType: 'CUSTOMER', actorId: request.auth.actorId,\n      action: 'customer.profile.update', targetType: 'customer', targetId: request.auth.actorId,\n      metadata: { changed_fields: changedFields }, requestIp: request.ip, requestId: request.id });\n    return { data: { customer: publicCustomer(updated.rows[0]) } };\n  }));\n\n`;
 s=s.slice(0,start)+replacement+s.slice(end);
 write(path,s);
}

// Merchant member detail exposes birthday only as explicit profile data for birthday-frequency eligibility visibility.
{
 const path='src/modules/loyalty/service.js';let s=read(path);
 s=s.replace('SELECT id,public_id,customer_code,display_name,email,phone_e164,status,created_at FROM customers','SELECT id,public_id,customer_code,display_name,email,phone_e164,birth_date,status,created_at FROM customers');
 write(path,s);
}

// Permanent commands/regressions and disposable-PostgreSQL lifecycle gate.
{
 const path='package.json';const pkg=JSON.parse(read(path));
 pkg.scripts['vip:issue-recurring']='node --env-file=.env src/scripts/issue-vip-entitlements.js';
 pkg.scripts['test:vip-recurring-entitlements']='node scripts/v0.15.0-vip-recurring-entitlements-v1-regression-test.mjs';
 if(!pkg.scripts.verify.includes('test:vip-recurring-entitlements'))pkg.scripts.verify+=' && npm run test:vip-recurring-entitlements';
 write(path,JSON.stringify(pkg,null,2)+'\n');
}
{
 const path='.github/workflows/ci.yml';let s=read(path);
 const source=`      - name: VIP cashback redemption v1 source/security guard\n        run: node scripts/v0.15.0-vip-cashback-redemption-v1-regression-test.mjs\n`;
 s=mustReplace(s,source,source+`      - name: VIP recurring voucher/gift issuance v1 source/security guard\n        run: node scripts/v0.15.0-vip-recurring-entitlements-v1-regression-test.mjs\n`,'CI source guard');
 const lifecycle=`      - name: VIP cashback redemption lifecycle\n        run: node --env-file=.env.ci scripts/vip-cashback-redemption-lifecycle-test.mjs\n`;
 s=mustReplace(s,lifecycle,lifecycle+`      - name: VIP recurring voucher/gift issuance lifecycle\n        run: node --env-file=.env.ci scripts/vip-recurring-entitlements-lifecycle-test.mjs\n`,'CI lifecycle guard');
 write(path,s);
}

console.log('VIP recurring entitlement integration patch applied');
