import { errors } from '../../core/errors.js';
import { writePlatformAudit } from '../../core/platform-audit.js';
import { listThemePackages, normalizeThemePackageInput } from './service.js';

const normalizeKey = (value) => String(value || '').trim().toUpperCase();
const normalizeVersion = (value) => String(value || '').trim();

async function findTheme(db, key, version, { forUpdate = false } = {}) {
  const result = await db.query(
    `SELECT * FROM platform_theme_packages WHERE key=$1 AND version=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [normalizeKey(key), normalizeVersion(version)],
  );
  if (!result.rowCount) throw errors.notFound('THEME_PACKAGE_NOT_FOUND', 'Theme package version not found');
  return result.rows[0];
}

export async function platformThemeRoutes(app) {
  app.get('/v1/platform/themes', { preHandler:[app.requirePlatformAuth] }, async request => ({
    data:{ themes:await listThemePackages(app.db,{ app:request.query?.app || null }) },
  }));

  app.post('/v1/platform/themes/install', {
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
    schema:{body:{type:'object',additionalProperties:false,required:['key','version','name','supported_apps','manifest'],properties:{
      key:{type:'string',minLength:2,maxLength:80},version:{type:'string',minLength:5,maxLength:80},name:{type:'string',minLength:2,maxLength:120},description:{type:'string',maxLength:1000},supported_apps:{type:'array',minItems:1,maxItems:2,items:{type:'string'}},manifest:{type:'object'},preview:{type:'object'},
    }}},
  }, async request => app.db.transaction(async client => {
    const theme=normalizeThemePackageInput(request.body);
    await client.query(
      `INSERT INTO platform_theme_packages(key,version,name,description,status,supported_apps,manifest,preview,created_by)
       VALUES($1,$2,$3,$4,'DRAFT',$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
      [theme.key,theme.version,theme.name,theme.description,JSON.stringify(theme.supported_apps),JSON.stringify(theme.manifest),JSON.stringify(theme.preview),request.platformAuth.actorId],
    );
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'theme.package.install',targetType:'platform_theme_package',metadata:{key:theme.key,version:theme.version,supported_apps:theme.supported_apps},requestIp:request.ip,requestId:request.id});
    return {data:{theme:{...theme,status:'DRAFT'}}};
  }));

  app.post('/v1/platform/themes/:themeKey/:themeVersion/publish', {
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
  }, async request => app.db.transaction(async client => {
    const row=await findTheme(client,request.params.themeKey,request.params.themeVersion,{forUpdate:true});
    if(row.status==='RETIRED') throw errors.conflict('THEME_PACKAGE_RETIRED','Retired theme versions cannot be republished');
    if(row.status!=='PUBLISHED'){
      await client.query(`UPDATE platform_theme_packages SET status='PUBLISHED',published_by=$1,published_at=now(),updated_at=now() WHERE id=$2`,[request.platformAuth.actorId,row.id]);
      await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'theme.package.publish',targetType:'platform_theme_package',targetId:row.id,metadata:{key:row.key,version:row.version},requestIp:request.ip,requestId:request.id});
    }
    const published=await findTheme(client,row.key,row.version);
    return {data:{theme:{key:published.key,version:published.version,name:published.name,description:published.description,status:published.status,supported_apps:published.supported_apps,manifest:published.manifest,preview:published.preview,published_at:published.published_at}}};
  }));

  app.post('/v1/platform/themes/:themeKey/:themeVersion/retire', {
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
  }, async request => app.db.transaction(async client => {
    const row=await findTheme(client,request.params.themeKey,request.params.themeVersion,{forUpdate:true});
    if(row.status==='DRAFT') throw errors.conflict('THEME_PACKAGE_NOT_PUBLISHED','Delete an unpublished draft instead of retiring it');
    if(row.status!=='RETIRED'){
      await client.query(`UPDATE platform_theme_packages SET status='RETIRED',updated_at=now() WHERE id=$1`,[row.id]);
      await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'theme.package.retire',targetType:'platform_theme_package',targetId:row.id,metadata:{key:row.key,version:row.version},requestIp:request.ip,requestId:request.id});
    }
    return {data:{retired:true,key:row.key,version:row.version}};
  }));

  app.delete('/v1/platform/themes/:themeKey/:themeVersion', {
    preHandler:[app.requirePlatformAuth,app.requirePlatformOwner],
  }, async request => app.db.transaction(async client => {
    const row=await findTheme(client,request.params.themeKey,request.params.themeVersion,{forUpdate:true});
    if(row.status!=='DRAFT') throw errors.conflict('THEME_PACKAGE_IMMUTABLE','Published or retired theme versions are immutable and cannot be deleted');
    await client.query('DELETE FROM platform_theme_packages WHERE id=$1',[row.id]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'theme.package.delete_draft',targetType:'platform_theme_package',targetId:row.id,metadata:{key:row.key,version:row.version},requestIp:request.ip,requestId:request.id});
    return {data:{deleted:true,key:row.key,version:row.version}};
  }));
}
