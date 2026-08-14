import { createHash, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { errors } from '../../core/errors.js';
import { normalizeEmail, publicId, uuid } from '../../core/identifiers.js';
import { hashPassword, assertPasswordPolicy } from '../../core/passwords.js';
import { provisionTenant } from './provisioning.js';
import { writePlatformAudit } from '../../core/platform-audit.js';
import { normalizeExperienceConfig } from '../customer-experience/service.js';
import { listStores, createStore, updateStore } from '../stores/service.js';

async function tenantByRef(db,ref,{forUpdate=false}={}){
  const r=await db.query(`SELECT * FROM tenants WHERE public_id=$1 OR slug=$1${forUpdate?' FOR UPDATE':''}`,[ref]);
  if(!r.rowCount) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
  return r.rows[0];
}
async function effectiveProfile(db,tenantId){
  const r=await db.query(
    `SELECT p.plan_key,p.modules AS overrides_modules,p.limits AS overrides_limits,p.capabilities AS overrides_capabilities,p.notes,
            pl.name AS plan_name,pl.modules AS plan_modules,pl.limits AS plan_limits,pl.capabilities AS plan_capabilities
       FROM tenant_platform_profiles p JOIN platform_plans pl ON pl.key=p.plan_key WHERE p.tenant_id=$1`,[tenantId]);
  if(!r.rowCount) return null;
  const x=r.rows[0];return {plan_key:x.plan_key,plan_name:x.plan_name,notes:x.notes,modules:{...(x.plan_modules||{}),...(x.overrides_modules||{})},limits:{...(x.plan_limits||{}),...(x.overrides_limits||{})},capabilities:{...(x.plan_capabilities||{}),...(x.overrides_capabilities||{})},overrides:{modules:x.overrides_modules||{},limits:x.overrides_limits||{},capabilities:x.overrides_capabilities||{}}};
}

export async function platformControlRoutes(app){
  const auth=[app.requirePlatformAuth];
  app.get('/v1/platform/overview',{preHandler:auth},async()=>{
    const [tenants,stores,customers,orders]=await Promise.all([
      app.db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='ACTIVE')::int AS active,count(*) FILTER(WHERE status='SUSPENDED')::int AS suspended FROM tenants`),
      app.db.query('SELECT count(*)::int AS total FROM stores'),app.db.query('SELECT count(*)::int AS total FROM customers'),app.db.query('SELECT count(*)::int AS total FROM orders'),
    ]);
    return {data:{tenants:tenants.rows[0],stores:stores.rows[0].total,customers:customers.rows[0].total,orders:orders.rows[0].total,release:app.config.release}};
  });

  app.get('/v1/platform/plans',{preHandler:auth},async()=>({data:{plans:(await app.db.query('SELECT key,name,description,status,modules,limits,capabilities FROM platform_plans ORDER BY key')).rows}}));
  app.get('/v1/platform/templates',{preHandler:auth},async()=>({data:{templates:(await app.db.query('SELECT public_id AS id,key,name,business_type,status,config,updated_at FROM platform_storefront_templates ORDER BY business_type,name')).rows}}));
  app.get('/v1/platform/typography-presets',{preHandler:auth},async()=>({data:{presets:(await app.db.query("SELECT key,name,category,status,heading_stack,body_stack,settings FROM platform_typography_presets ORDER BY category,name")).rows}}));


  app.post('/v1/platform/plans',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,required:['key','name'],properties:{key:{type:'string',minLength:2,maxLength:40},name:{type:'string',minLength:2,maxLength:120},description:{type:['string','null'],maxLength:1000},status:{type:'string',enum:['ACTIVE','INACTIVE']},modules:{type:'object'},limits:{type:'object'},capabilities:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const key=String(request.body.key).trim().toUpperCase();await client.query(`INSERT INTO platform_plans(key,name,description,status,modules,limits,capabilities) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,[key,request.body.name.trim(),request.body.description||null,request.body.status||'ACTIVE',JSON.stringify(request.body.modules||{}),JSON.stringify(request.body.limits||{}),JSON.stringify(request.body.capabilities||{})]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.plan.create',targetType:'platform_plan',targetId:null,metadata:{key},requestIp:request.ip,requestId:request.id});return {data:{plan:(await client.query('SELECT key,name,description,status,modules,limits,capabilities FROM platform_plans WHERE key=$1',[key])).rows[0]}};}));

  app.patch('/v1/platform/plans/:planKey',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{name:{type:'string',minLength:2,maxLength:120},description:{type:['string','null'],maxLength:1000},status:{type:'string',enum:['ACTIVE','INACTIVE']},modules:{type:'object'},limits:{type:'object'},capabilities:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const key=String(request.params.planKey).trim().toUpperCase();const row=(await client.query('SELECT * FROM platform_plans WHERE key=$1 FOR UPDATE',[key])).rows[0];if(!row)throw errors.notFound('PLATFORM_PLAN_NOT_FOUND','Platform plan not found');await client.query(`UPDATE platform_plans SET name=$1,description=$2,status=$3,modules=$4::jsonb,limits=$5::jsonb,capabilities=$6::jsonb,updated_at=now() WHERE key=$7`,[request.body.name??row.name,request.body.description!==undefined?request.body.description:row.description,request.body.status??row.status,JSON.stringify(request.body.modules??row.modules),JSON.stringify(request.body.limits??row.limits),JSON.stringify(request.body.capabilities??row.capabilities),key]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.plan.update',targetType:'platform_plan',metadata:{key,changed_fields:Object.keys(request.body)},requestIp:request.ip,requestId:request.id});return {data:{plan:(await client.query('SELECT key,name,description,status,modules,limits,capabilities FROM platform_plans WHERE key=$1',[key])).rows[0]}};}));

  app.post('/v1/platform/typography-presets',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,required:['key','name','category','heading_stack','body_stack'],properties:{key:{type:'string',minLength:2,maxLength:80},name:{type:'string',minLength:2,maxLength:120},category:{type:'string',minLength:2,maxLength:60},status:{type:'string',enum:['ACTIVE','INACTIVE']},heading_stack:{type:'string',minLength:2,maxLength:1000},body_stack:{type:'string',minLength:2,maxLength:1000},settings:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const key=String(request.body.key).trim().toUpperCase();await client.query(`INSERT INTO platform_typography_presets(key,name,category,status,heading_stack,body_stack,settings) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[key,request.body.name.trim(),request.body.category.trim().toUpperCase(),request.body.status||'ACTIVE',request.body.heading_stack.trim(),request.body.body_stack.trim(),JSON.stringify(request.body.settings||{})]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'typography.preset.create',targetType:'typography_preset',metadata:{key},requestIp:request.ip,requestId:request.id});return {data:{preset:(await client.query('SELECT key,name,category,status,heading_stack,body_stack,settings FROM platform_typography_presets WHERE key=$1',[key])).rows[0]}};}));

  app.patch('/v1/platform/typography-presets/:presetKey',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{name:{type:'string',minLength:2,maxLength:120},category:{type:'string',minLength:2,maxLength:60},status:{type:'string',enum:['ACTIVE','INACTIVE']},heading_stack:{type:'string',minLength:2,maxLength:1000},body_stack:{type:'string',minLength:2,maxLength:1000},settings:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const key=String(request.params.presetKey).trim().toUpperCase();const row=(await client.query('SELECT * FROM platform_typography_presets WHERE key=$1 FOR UPDATE',[key])).rows[0];if(!row)throw errors.notFound('TYPOGRAPHY_PRESET_NOT_FOUND','Typography preset not found');await client.query(`UPDATE platform_typography_presets SET name=$1,category=$2,status=$3,heading_stack=$4,body_stack=$5,settings=$6::jsonb,updated_at=now() WHERE key=$7`,[request.body.name??row.name,request.body.category?request.body.category.trim().toUpperCase():row.category,request.body.status??row.status,request.body.heading_stack??row.heading_stack,request.body.body_stack??row.body_stack,JSON.stringify(request.body.settings??row.settings),key]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'typography.preset.update',targetType:'typography_preset',metadata:{key,changed_fields:Object.keys(request.body)},requestIp:request.ip,requestId:request.id});return {data:{preset:(await client.query('SELECT key,name,category,status,heading_stack,body_stack,settings FROM platform_typography_presets WHERE key=$1',[key])).rows[0]}};}));

  app.post('/v1/platform/templates',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,required:['key','name','business_type','config'],properties:{key:{type:'string',minLength:2,maxLength:80},name:{type:'string',minLength:2,maxLength:120},business_type:{type:'string',minLength:2,maxLength:80},status:{type:'string',enum:['ACTIVE','INACTIVE']},config:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const key=String(request.body.key).trim().toUpperCase();const id=uuid(),pid=publicId('tpl');const config=normalizeExperienceConfig(request.body.config);await client.query(`INSERT INTO platform_storefront_templates(id,public_id,key,name,business_type,status,config,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[id,pid,key,request.body.name.trim(),request.body.business_type.trim().toUpperCase(),request.body.status||'ACTIVE',JSON.stringify(config),request.platformAuth.actorId]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'storefront.template.create',targetType:'storefront_template',targetId:id,metadata:{key,name:request.body.name},requestIp:request.ip,requestId:request.id});return {data:{template:{id:pid,key,name:request.body.name,status:request.body.status||'ACTIVE',config}}};}));

  app.patch('/v1/platform/templates/:templateRef',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{name:{type:'string',minLength:2,maxLength:120},business_type:{type:'string',minLength:2,maxLength:80},status:{type:'string',enum:['ACTIVE','INACTIVE']},config:{type:'object'}}}}},async request=>app.db.transaction(async client=>{const found=await client.query('SELECT * FROM platform_storefront_templates WHERE public_id=$1 OR key=$1 FOR UPDATE',[request.params.templateRef]);if(!found.rowCount)throw errors.notFound('STOREFRONT_TEMPLATE_NOT_FOUND','Storefront template not found');const row=found.rows[0];const config=request.body.config?normalizeExperienceConfig(request.body.config):row.config;await client.query('UPDATE platform_storefront_templates SET name=$1,business_type=$2,status=$3,config=$4::jsonb,updated_at=now() WHERE id=$5',[request.body.name??row.name,request.body.business_type?request.body.business_type.toUpperCase():row.business_type,request.body.status??row.status,JSON.stringify(config),row.id]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'storefront.template.update',targetType:'storefront_template',targetId:row.id,metadata:{key:row.key,changed_fields:Object.keys(request.body)},requestIp:request.ip,requestId:request.id});return {data:{updated:true}};}));

  app.get('/v1/platform/tenants',{preHandler:auth},async request=>{
    const status=request.query?.status?String(request.query.status).toUpperCase():null;
    const q=request.query?.q?`%${String(request.query.q).trim().toLowerCase()}%`:null;
    const r=await app.db.query(
      `SELECT t.public_id AS id,t.slug,t.name,t.status,t.created_at,p.plan_key,
              (SELECT count(*)::int FROM stores s WHERE s.tenant_id=t.id) AS stores,
              (SELECT count(*)::int FROM merchant_users u WHERE u.tenant_id=t.id AND u.status='ACTIVE') AS active_staff,
              (SELECT count(*)::int FROM customers c WHERE c.tenant_id=t.id) AS customers
         FROM tenants t LEFT JOIN tenant_platform_profiles p ON p.tenant_id=t.id
        WHERE ($1::text IS NULL OR t.status=$1) AND ($2::text IS NULL OR lower(t.name) LIKE $2 OR lower(t.slug) LIKE $2)
        ORDER BY t.created_at DESC LIMIT 250`,[status,q]);
    return {data:{tenants:r.rows}};
  });

  app.get('/v1/platform/tenants/:tenantRef',{preHandler:auth},async request=>{
    const t=await tenantByRef(app.db,request.params.tenantRef);
    const [settings,owner,profile,storeCounts,primaryStore,domains,storesList]=await Promise.all([
      app.db.query('SELECT currency,locale,timezone,modules,branding,customer_service FROM tenant_settings WHERE tenant_id=$1',[t.id]),
      app.db.query(`SELECT u.public_id AS id,u.email,u.display_name,u.status,u.last_login_at FROM merchant_users u JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id JOIN merchant_roles r ON r.id=ur.role_id WHERE u.tenant_id=$1 AND r.key='OWNER' ORDER BY u.created_at LIMIT 1`,[t.id]),
      effectiveProfile(app.db,t.id),app.db.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE status=\'ACTIVE\')::int AS active FROM stores WHERE tenant_id=$1',[t.id]),
      app.db.query('SELECT public_id AS id,slug,name,status,is_primary FROM stores WHERE tenant_id=$1 AND is_primary=true LIMIT 1',[t.id]),
      app.db.query(`SELECT d.public_id AS id,d.hostname,d.status,d.is_primary,d.verified_at,s.public_id AS store_id,s.slug AS store_slug
                      FROM storefront_domains d LEFT JOIN stores s ON s.id=d.store_id WHERE d.tenant_id=$1 ORDER BY d.is_primary DESC,d.created_at DESC`,[t.id]),
      app.db.query('SELECT public_id AS id,slug,name,status,is_primary,created_at,updated_at FROM stores WHERE tenant_id=$1 ORDER BY is_primary DESC,name',[t.id]),
    ]);
    const primary=primaryStore.rows[0]||null;
    return {data:{tenant:{id:t.public_id,slug:t.slug,name:t.name,status:t.status,created_at:t.created_at,settings:settings.rows[0]||null,owner:owner.rows[0]||null,platform:profile,stores:storeCounts.rows[0],store_list:storesList.rows,primary_store:primary,storefront_path:`/t/${t.slug}`,domains:domains.rows}}};
  });

  app.post('/v1/platform/tenants',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['slug','name','owner_email','owner_password'],properties:{slug:{type:'string',minLength:1,maxLength:63},name:{type:'string',minLength:1,maxLength:160},owner_email:{type:'string',minLength:5,maxLength:254},owner_password:{type:'string',minLength:12,maxLength:128},owner_name:{type:'string',maxLength:120},plan_key:{type:'string',maxLength:40},template_key:{type:'string',maxLength:80},currency:{type:'string',minLength:3,maxLength:3},locale:{type:'string',maxLength:20},timezone:{type:'string',maxLength:64},modules:{type:'object'},limits:{type:'object'},capabilities:{type:'object'},notes:{type:'string',maxLength:2000}}}},
  },async request=>{
    try{
      const result=await app.db.transaction(async client=>{
        const created=await provisionTenant(client,request.body,{platformUserId:request.platformAuth.actorId});
        await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.provision',tenantId:created.tenant.id,targetType:'tenant',targetId:created.tenant.id,metadata:{plan_key:created.plan_key,template_key:created.template_key,slug:created.tenant.slug},requestIp:request.ip,requestId:request.id});
        return created;
      });
      return {data:{created:true,...result}};
    }catch(e){if(e.code==='23505') throw e;throw errors.badRequest('TENANT_PROVISION_FAILED',e.message);}
  });

  app.patch('/v1/platform/tenants/:tenantRef',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{name:{type:'string',minLength:1,maxLength:160},status:{type:'string',enum:['ACTIVE','SUSPENDED','DISABLED']},plan_key:{type:'string',maxLength:40},modules:{type:'object'},limits:{type:'object'},capabilities:{type:'object'},notes:{type:['string','null'],maxLength:2000},currency:{type:'string',minLength:3,maxLength:3},locale:{type:'string',minLength:2,maxLength:20},timezone:{type:'string',minLength:1,maxLength:64}}}},
  },async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1 FOR UPDATE',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const body=request.body||{};
    if(body.name||body.status) await client.query('UPDATE tenants SET name=COALESCE($1,name),status=COALESCE($2,status),updated_at=now() WHERE id=$3',[body.name||null,body.status||null,t.id]);
    const current=(await client.query('SELECT * FROM tenant_platform_profiles WHERE tenant_id=$1 FOR UPDATE',[t.id])).rows[0];
    const planKey=body.plan_key||current?.plan_key||'STARTER';
    const plan=(await client.query('SELECT * FROM platform_plans WHERE key=$1 AND status=\'ACTIVE\'',[planKey])).rows[0];
    if(!plan) throw errors.badRequest('PLATFORM_PLAN_INVALID','Active platform plan not found');
    const modules=body.modules??current?.modules??{},limits=body.limits??current?.limits??{},capabilities=body.capabilities??current?.capabilities??{};
    await client.query(
      `INSERT INTO tenant_platform_profiles(tenant_id,plan_key,modules,limits,capabilities,notes,created_by)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
       ON CONFLICT(tenant_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,modules=EXCLUDED.modules,limits=EXCLUDED.limits,capabilities=EXCLUDED.capabilities,notes=EXCLUDED.notes,updated_at=now()`,
      [t.id,planKey,JSON.stringify(modules),JSON.stringify(limits),JSON.stringify(capabilities),body.notes??current?.notes??null,request.platformAuth.actorId],
    );
    const effectiveModules={...(plan.modules||{}),...(modules||{})};
    const settings=(await client.query('SELECT currency,locale,timezone FROM tenant_settings WHERE tenant_id=$1 FOR UPDATE',[t.id])).rows[0];
    if(!settings) throw errors.notFound('TENANT_SETTINGS_NOT_FOUND','Tenant settings not found');
    await client.query(
      'UPDATE tenant_settings SET modules=$1::jsonb,currency=$2,locale=$3,timezone=$4,updated_at=now() WHERE tenant_id=$5',
      [JSON.stringify(effectiveModules),String(body.currency??settings.currency).trim().toUpperCase(),String(body.locale??settings.locale).trim(),String(body.timezone??settings.timezone).trim(),t.id],
    );
    if(body.status&&body.status!=='ACTIVE') await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1',[t.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.update',tenantId:t.id,targetType:'tenant',targetId:t.id,metadata:{changed_fields:Object.keys(body)},requestIp:request.ip,requestId:request.id});
    return {data:{updated:true}};
  }));

  app.patch('/v1/platform/tenants/:tenantRef/owner',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{display_name:{type:'string',minLength:1,maxLength:120},email:{type:'string',minLength:5,maxLength:254},status:{type:'string',enum:['ACTIVE','SUSPENDED','BLOCKED']}}}},
  },async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const owner=(await client.query(`SELECT u.* FROM merchant_users u JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id JOIN merchant_roles r ON r.id=ur.role_id WHERE u.tenant_id=$1 AND r.key='OWNER' ORDER BY u.created_at LIMIT 1 FOR UPDATE OF u`,[t.id])).rows[0];
    if(!owner) throw errors.notFound('TENANT_OWNER_NOT_FOUND','Tenant owner not found');
    const displayName=request.body.display_name===undefined?owner.display_name:String(request.body.display_name).trim();
    const email=request.body.email===undefined?owner.email:normalizeEmail(request.body.email);
    const status=request.body.status??owner.status;
    try{
      await client.query('UPDATE merchant_users SET display_name=$1,email=$2,status=$3,updated_at=now() WHERE id=$4',[displayName,email,status,owner.id]);
    }catch(error){
      if(error?.code==='23505') throw errors.conflict('TENANT_OWNER_EMAIL_IN_USE','Owner email is already used by another merchant account in this tenant');
      throw error;
    }
    let revoked=0;
    if(status!=='ACTIVE'){
      const sessions=await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND merchant_user_id=$2 AND revoked_at IS NULL',[t.id,owner.id]);
      revoked=sessions.rowCount;
    }
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.owner.update',tenantId:t.id,targetType:'merchant_user',targetId:owner.id,metadata:{changed_fields:Object.keys(request.body),sessions_revoked:revoked},requestIp:request.ip,requestId:request.id});
    return {data:{owner:{id:owner.public_id,display_name:displayName,email,status},sessions_revoked:revoked}};
  }));

  app.post('/v1/platform/tenants/:tenantRef/owner/reset-password',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['new_password'],properties:{new_password:{type:'string',minLength:12,maxLength:128}}}},
  },async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const owner=(await client.query(`SELECT u.id FROM merchant_users u JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id JOIN merchant_roles r ON r.id=ur.role_id WHERE u.tenant_id=$1 AND r.key='OWNER' ORDER BY u.created_at LIMIT 1`,[t.id])).rows[0];
    if(!owner) throw errors.notFound('TENANT_OWNER_NOT_FOUND','Tenant owner not found');
    const hash=await hashPassword(assertPasswordPolicy(request.body.new_password));
    await client.query('UPDATE merchant_users SET password_hash=$1,updated_at=now() WHERE id=$2',[hash,owner.id]);
    await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND merchant_user_id=$2',[t.id,owner.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.owner.password_reset',tenantId:t.id,targetType:'merchant_user',targetId:owner.id,requestIp:request.ip,requestId:request.id});
    return {data:{reset:true,sessions_revoked:true}};
  }));

  app.post('/v1/platform/tenants/:tenantRef/owner/force-logout',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const owner=(await client.query(`SELECT u.id FROM merchant_users u JOIN merchant_user_roles ur ON ur.tenant_id=u.tenant_id AND ur.merchant_user_id=u.id JOIN merchant_roles r ON r.id=ur.role_id WHERE u.tenant_id=$1 AND r.key='OWNER' ORDER BY u.created_at LIMIT 1`,[t.id])).rows[0];
    if(!owner) throw errors.notFound('TENANT_OWNER_NOT_FOUND','Tenant owner not found');
    const r=await client.query('UPDATE merchant_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND merchant_user_id=$2 AND revoked_at IS NULL',[t.id,owner.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.owner.force_logout',tenantId:t.id,targetType:'merchant_user',targetId:owner.id,metadata:{sessions_revoked:r.rowCount},requestIp:request.ip,requestId:request.id});
    return {data:{sessions_revoked:r.rowCount}};
  }));


  app.get('/v1/platform/tenants/:tenantRef/stores',{preHandler:auth},async request=>{const t=await tenantByRef(app.db,request.params.tenantRef);return {data:{stores:await listStores(app.db,t.id)}};});

  app.post('/v1/platform/tenants/:tenantRef/stores',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,required:['name','slug'],properties:{name:{type:'string',minLength:1,maxLength:160},slug:{type:'string',minLength:1,maxLength:80},is_primary:{type:'boolean'},template_key:{type:'string',maxLength:80}}}}},async request=>app.db.transaction(async client=>{const t=await tenantByRef(client,request.params.tenantRef,{forUpdate:true});const created=await createStore(client,{tenantId:t.id,name:request.body.name,slug:request.body.slug,isPrimary:Boolean(request.body.is_primary),templateKey:request.body.template_key||'MODERN_COMMERCE'});await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.store.create',tenantId:t.id,targetType:'store',metadata:{store_id:created.id,slug:created.slug},requestIp:request.ip,requestId:request.id});return {data:{store:created}};}));

  app.patch('/v1/platform/tenants/:tenantRef/stores/:storeRef',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{name:{type:'string',minLength:1,maxLength:160},slug:{type:'string',minLength:1,maxLength:80},status:{type:'string',enum:['ACTIVE','INACTIVE']},is_primary:{type:'boolean'}}}}},async request=>app.db.transaction(async client=>{const t=await tenantByRef(client,request.params.tenantRef,{forUpdate:true});const result=await updateStore(client,{tenantId:t.id,storeRef:request.params.storeRef,patch:request.body});await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'tenant.store.update',tenantId:t.id,targetType:'store',targetId:result.internalId,metadata:{store_id:result.row.id,changed_fields:Object.keys(request.body)},requestIp:request.ip,requestId:request.id});return {data:{store:result.row}};}));


  app.get('/v1/platform/tenants/:tenantRef/domains',{preHandler:auth},async request=>{
    const t=await tenantByRef(app.db,request.params.tenantRef);
    const rows=await app.db.query(`SELECT d.public_id AS id,d.hostname,d.status,d.is_primary,d.created_at,d.verified_at,
                                           s.public_id AS store_id,s.slug AS store_slug,s.name AS store_name
                                      FROM storefront_domains d LEFT JOIN stores s ON s.id=d.store_id
                                     WHERE d.tenant_id=$1 ORDER BY d.is_primary DESC,d.created_at DESC`,[t.id]);
    return {data:{domains:rows.rows}};
  });

  app.post('/v1/platform/tenants/:tenantRef/domains',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['hostname'],properties:{hostname:{type:'string',minLength:3,maxLength:253},store_id:{type:['string','null'],maxLength:140},is_primary:{type:'boolean'}}}},
  },async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1 FOR UPDATE',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const hostname=String(request.body.hostname||'').trim().toLowerCase().replace(/\.$/,'');
    if(!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw errors.badRequest('STOREFRONT_DOMAIN_INVALID','Enter a valid hostname without protocol or path');
    let store=null;
    if(request.body.store_id) store=(await client.query('SELECT id,public_id,slug FROM stores WHERE tenant_id=$1 AND public_id=$2',[t.id,request.body.store_id])).rows[0];
    else store=(await client.query('SELECT id,public_id,slug FROM stores WHERE tenant_id=$1 AND is_primary=true LIMIT 1',[t.id])).rows[0];
    if(!store) throw errors.notFound('STORE_NOT_FOUND','Store not found');
    const verificationToken=randomBytes(24).toString('base64url');
    const tokenHash=createHash('sha256').update(verificationToken).digest('hex');
    const id=uuid(),pid=publicId('dom');
    await client.query(`INSERT INTO storefront_domains(id,public_id,tenant_id,store_id,hostname,status,verification_token_hash,is_primary,created_by)
                        VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7,$8)`,[id,pid,t.id,store.id,hostname,tokenHash,Boolean(request.body.is_primary),request.platformAuth.actorId]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'storefront.domain.create',tenantId:t.id,targetType:'storefront_domain',targetId:id,metadata:{hostname,store_id:store.public_id},requestIp:request.ip,requestId:request.id});
    return {data:{domain:{id:pid,hostname,status:'PENDING',store_id:store.public_id,store_slug:store.slug,is_primary:Boolean(request.body.is_primary)},verification:{type:'TXT',name:`_luke-shop.${hostname}`,value:`luke-shop-verification=${verificationToken}`}}};
  }));

  app.post('/v1/platform/tenants/:tenantRef/domains/:domainRef/verify',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>{
    const t=await tenantByRef(app.db,request.params.tenantRef);const domain=(await app.db.query('SELECT * FROM storefront_domains WHERE tenant_id=$1 AND public_id=$2',[t.id,request.params.domainRef])).rows[0];if(!domain)throw errors.notFound('STOREFRONT_DOMAIN_NOT_FOUND','Domain not found');const recordName=`_luke-shop.${domain.hostname}`;let records=[];try{records=(await resolveTxt(recordName)).flat().map(String);}catch(error){if(!['ENODATA','ENOTFOUND','ESERVFAIL','ETIMEOUT'].includes(error?.code))throw error;}const prefix='luke-shop-verification=';const matched=records.map(v=>v.trim()).filter(v=>v.startsWith(prefix)).some(v=>createHash('sha256').update(v.slice(prefix.length)).digest('hex')===domain.verification_token_hash);if(!matched)throw errors.conflict('STOREFRONT_DOMAIN_DNS_NOT_VERIFIED',`DNS TXT record not verified. Add ${recordName} with the verification value provided when the domain was created`);return app.db.transaction(async client=>{const locked=(await client.query('SELECT * FROM storefront_domains WHERE tenant_id=$1 AND public_id=$2 FOR UPDATE',[t.id,request.params.domainRef])).rows[0];if(!locked)throw errors.notFound('STOREFRONT_DOMAIN_NOT_FOUND','Domain not found');if(locked.is_primary)await client.query("UPDATE storefront_domains SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND id<>$2 AND status='VERIFIED'",[t.id,locked.id]);await client.query("UPDATE storefront_domains SET status='VERIFIED',verified_at=COALESCE(verified_at,now()),updated_at=now() WHERE id=$1",[locked.id]);await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'storefront.domain.verify_dns',tenantId:t.id,targetType:'storefront_domain',targetId:locked.id,metadata:{hostname:locked.hostname,record_name:recordName},requestIp:request.ip,requestId:request.id});return {data:{verified:true,hostname:locked.hostname,record_name:recordName}};});
  });

  app.delete('/v1/platform/tenants/:tenantRef/domains/:domainRef',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>app.db.transaction(async client=>{
    const t=(await client.query('SELECT * FROM tenants WHERE public_id=$1 OR slug=$1',[request.params.tenantRef])).rows[0];
    if(!t) throw errors.notFound('TENANT_NOT_FOUND','Tenant not found');
    const domain=(await client.query('DELETE FROM storefront_domains WHERE tenant_id=$1 AND public_id=$2 RETURNING id,hostname',[t.id,request.params.domainRef])).rows[0];
    if(!domain) throw errors.notFound('STOREFRONT_DOMAIN_NOT_FOUND','Domain not found');
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'storefront.domain.delete',tenantId:t.id,targetType:'storefront_domain',targetId:domain.id,metadata:{hostname:domain.hostname},requestIp:request.ip,requestId:request.id});
    return {data:{deleted:true}};
  }));

  app.get('/v1/platform/audit',{preHandler:auth},async()=>({data:{events:(await app.db.query(`SELECT a.id,a.action,a.metadata,a.created_at,a.request_id,u.display_name AS actor,t.slug AS tenant_slug FROM platform_audit_logs a LEFT JOIN platform_users u ON u.id=a.actor_id LEFT JOIN tenants t ON t.id=a.tenant_id ORDER BY a.created_at DESC LIMIT 200`)).rows}}));
}
