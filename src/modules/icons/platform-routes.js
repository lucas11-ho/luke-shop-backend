import { errors } from '../../core/errors.js';
import { writePlatformAudit } from '../../core/platform-audit.js';
import { findPlatformIcon,listPlatformIcons,normalizeLibraryIconInput,normalizeUsageScopes,publicPlatformIcon } from './service.js';

export async function platformIconRoutes(app){
  app.get('/v1/platform/icons',{preHandler:[app.requirePlatformAuth]},async request=>({
    data:{icons:await listPlatformIcons(app.db,{status:request.query?.status||null,scope:request.query?.scope||null})},
  }));

  app.post('/v1/platform/icons',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['key','name','library_pack','library_icon','usage_scopes'],properties:{
      key:{type:'string',minLength:3,maxLength:80},name:{type:'string',minLength:2,maxLength:120},library_pack:{type:'string'},library_icon:{type:'string'},color_mode:{type:'string'},usage_scopes:{type:'array',minItems:1,maxItems:5,items:{type:'string'}},tags:{type:'array',maxItems:20,items:{type:'string'}},
    }}},
  },async request=>app.db.transaction(async client=>{
    const icon=normalizeLibraryIconInput(request.body);
    const result=await client.query(
      `INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status,created_by)
       VALUES($1,$2,'LIBRARY',$3,$4,$5,$6::jsonb,$7::jsonb,'DRAFT',$8) RETURNING *`,
      [icon.key,icon.name,icon.library_pack,icon.library_icon,icon.color_mode,JSON.stringify(icon.usage_scopes),JSON.stringify(icon.tags),request.platformAuth.actorId],
    );
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'icon.library.create_draft',targetType:'platform_icon',targetId:result.rows[0].id,metadata:{key:icon.key,library_pack:icon.library_pack,library_icon:icon.library_icon,usage_scopes:icon.usage_scopes},requestIp:request.ip,requestId:request.id});
    return {data:{icon:publicPlatformIcon(result.rows[0])}};
  }));

  app.put('/v1/platform/icons/:iconKey/scopes',{
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['usage_scopes'],properties:{usage_scopes:{type:'array',minItems:1,maxItems:5,items:{type:'string'}}}}},
  },async request=>app.db.transaction(async client=>{
    const row=await findPlatformIcon(client,request.params.iconKey,{forUpdate:true});
    if(row.status==='RETIRED')throw errors.conflict('PLATFORM_ICON_RETIRED','Retired icons cannot be changed');
    const scopes=normalizeUsageScopes(request.body.usage_scopes);
    const updated=await client.query(`UPDATE platform_icons SET usage_scopes=$1::jsonb,updated_at=now() WHERE id=$2 RETURNING *`,[JSON.stringify(scopes),row.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'icon.library.scopes.update',targetType:'platform_icon',targetId:row.id,metadata:{key:row.key,usage_scopes:scopes},requestIp:request.ip,requestId:request.id});
    return {data:{icon:publicPlatformIcon(updated.rows[0])}};
  }));

  app.post('/v1/platform/icons/:iconKey/publish',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>app.db.transaction(async client=>{
    const row=await findPlatformIcon(client,request.params.iconKey,{forUpdate:true});
    if(row.status==='RETIRED')throw errors.conflict('PLATFORM_ICON_RETIRED','Retired icons cannot be republished');
    if(row.status!=='PUBLISHED'){
      await client.query(`UPDATE platform_icons SET status='PUBLISHED',published_by=$1,published_at=now(),updated_at=now() WHERE id=$2`,[request.platformAuth.actorId,row.id]);
      await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'icon.library.publish',targetType:'platform_icon',targetId:row.id,metadata:{key:row.key},requestIp:request.ip,requestId:request.id});
    }
    return {data:{icon:publicPlatformIcon(await findPlatformIcon(client,row.key))}};
  }));

  app.post('/v1/platform/icons/:iconKey/retire',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>app.db.transaction(async client=>{
    const row=await findPlatformIcon(client,request.params.iconKey,{forUpdate:true});
    if(row.status==='DRAFT')throw errors.conflict('PLATFORM_ICON_NOT_PUBLISHED','Delete an unpublished icon draft instead of retiring it');
    if(row.status!=='RETIRED'){
      await client.query(`UPDATE platform_icons SET status='RETIRED',retired_at=now(),updated_at=now() WHERE id=$1`,[row.id]);
      await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'icon.library.retire',targetType:'platform_icon',targetId:row.id,metadata:{key:row.key},requestIp:request.ip,requestId:request.id});
    }
    return {data:{retired:true,key:row.key}};
  }));

  app.delete('/v1/platform/icons/:iconKey',{preHandler:[app.requirePlatformAuth,app.requirePlatformOwner]},async request=>app.db.transaction(async client=>{
    const row=await findPlatformIcon(client,request.params.iconKey,{forUpdate:true});
    if(row.status!=='DRAFT')throw errors.conflict('PLATFORM_ICON_IMMUTABLE','Published or retired icons cannot be deleted');
    await client.query('DELETE FROM platform_icons WHERE id=$1',[row.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'icon.library.delete_draft',targetType:'platform_icon',targetId:row.id,metadata:{key:row.key},requestIp:request.ip,requestId:request.id});
    return {data:{deleted:true,key:row.key}};
  }));
}
