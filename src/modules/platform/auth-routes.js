import { errors } from '../../core/errors.js';
import { normalizeEmail, publicId, uuid } from '../../core/identifiers.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../../core/passwords.js';
import { newRefreshToken,hashRefreshToken,signPlatformAccessToken } from '../../core/tokens.js';
import { writePlatformAudit } from '../../core/platform-audit.js';

async function issue(app,client,user,request,sessionId=uuid()){
  const refresh=newRefreshToken();
  const expires=new Date(Date.now()+app.config.refreshTokenTtlDays*86400000);
  await client.query(
    `INSERT INTO platform_sessions(id,public_id,platform_user_id,refresh_token_hash,user_agent,request_ip,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId,publicId('pses'),user.id,hashRefreshToken(refresh),request.headers['user-agent']||null,request.ip,expires],
  );
  const access=await signPlatformAccessToken(app.config,{subject:user.id,sessionId,role:user.role});
  return {access_token:access.token,expires_in:access.expiresIn,refresh_token:refresh};
}

export async function platformAuthRoutes(app){
  app.post('/v1/platform/auth/login',{
    config:{rateLimit:{max:app.config.authRateLimitMax,timeWindow:'1 minute'}},
    schema:{body:{type:'object',additionalProperties:false,required:['email','password'],properties:{email:{type:'string',minLength:5,maxLength:254},password:{type:'string',minLength:12,maxLength:128}}}},
  },async request=>{
    const email=normalizeEmail(request.body.email);
    return app.db.transaction(async client=>{
      const r=await client.query('SELECT * FROM platform_users WHERE email=$1 FOR UPDATE',[email]);
      const user=r.rows[0];
      const valid=user?await verifyPassword(user.password_hash,request.body.password):false;
      if(!valid) throw errors.unauthorized('INVALID_CREDENTIALS','Invalid email or password');
      if(user.status!=='ACTIVE') throw errors.forbidden('PLATFORM_USER_NOT_ACTIVE','Platform account is not active');
      const tokens=await issue(app,client,user,request);
      await client.query('UPDATE platform_users SET last_login_at=now(),updated_at=now() WHERE id=$1',[user.id]);
      await writePlatformAudit(client,{actorId:user.id,action:'platform.login',targetType:'platform_user',targetId:user.id,requestIp:request.ip,requestId:request.id});
      return {data:{user:{id:user.public_id,email:user.email,display_name:user.display_name,role:user.role,status:user.status},tokens}};
    });
  });

  app.post('/v1/platform/auth/refresh',{
    config:{rateLimit:{max:app.config.authRateLimitMax,timeWindow:'1 minute'}},
    schema:{body:{type:'object',additionalProperties:false,required:['refresh_token'],properties:{refresh_token:{type:'string',minLength:40,maxLength:512}}}},
  },async request=>app.db.transaction(async client=>{
    const r=await client.query(
      `SELECT s.id AS session_id,u.* FROM platform_sessions s JOIN platform_users u ON u.id=s.platform_user_id
       WHERE s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE`,[hashRefreshToken(request.body.refresh_token)]);
    if(!r.rowCount||r.rows[0].status!=='ACTIVE') throw errors.unauthorized('REFRESH_TOKEN_INVALID','Refresh token is invalid or expired');
    const user=r.rows[0],nextRefresh=newRefreshToken();
    await client.query('UPDATE platform_sessions SET refresh_token_hash=$1,last_seen_at=now() WHERE id=$2',[hashRefreshToken(nextRefresh),user.session_id]);
    const access=await signPlatformAccessToken(app.config,{subject:user.id,sessionId:user.session_id,role:user.role});
    return {data:{tokens:{access_token:access.token,expires_in:access.expiresIn,refresh_token:nextRefresh}}};
  }));

  app.post('/v1/platform/auth/logout',{preHandler:[app.requirePlatformAuth]},async request=>app.db.transaction(async client=>{
    await client.query('UPDATE platform_sessions SET revoked_at=now(),last_seen_at=now() WHERE id=$1 AND platform_user_id=$2 AND revoked_at IS NULL',[request.platformAuth.sessionId,request.platformAuth.actorId]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.logout',targetType:'platform_session',targetId:request.platformAuth.sessionId,requestIp:request.ip,requestId:request.id});
    return {data:{logged_out:true}};
  }));

  app.get('/v1/platform/me',{preHandler:[app.requirePlatformAuth]},async request=>({data:{user:{id:request.platformAuth.profile.public_id,email:request.platformAuth.profile.email,display_name:request.platformAuth.profile.display_name,role:request.platformAuth.role,status:request.platformAuth.profile.status,password_changed_at:request.platformAuth.profile.password_changed_at||null}}}));

  app.patch('/v1/platform/me',{
    preHandler:[app.requirePlatformAuth],
    schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{display_name:{type:'string',minLength:1,maxLength:120}}}},
  },async request=>app.db.transaction(async client=>{
    const row=await client.query('UPDATE platform_users SET display_name=$1,updated_at=now() WHERE id=$2 RETURNING public_id,email,display_name,role,status,password_changed_at',[request.body.display_name.trim(),request.platformAuth.actorId]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.profile.update',targetType:'platform_user',targetId:request.platformAuth.actorId,metadata:{changed_fields:['display_name']},requestIp:request.ip,requestId:request.id});
    return {data:{user:row.rows[0]}};
  }));

  app.post('/v1/platform/me/change-password',{
    preHandler:[app.requirePlatformAuth],config:{rateLimit:{max:10,timeWindow:'1 minute'}},
    schema:{body:{type:'object',additionalProperties:false,required:['current_password','new_password'],properties:{current_password:{type:'string',minLength:12,maxLength:128},new_password:{type:'string',minLength:12,maxLength:128}}}},
  },async request=>app.db.transaction(async client=>{
    const found=await client.query('SELECT password_hash FROM platform_users WHERE id=$1 FOR UPDATE',[request.platformAuth.actorId]);
    if(!found.rowCount||!await verifyPassword(found.rows[0].password_hash,request.body.current_password)) throw errors.unauthorized('CURRENT_PASSWORD_INVALID','Current password is incorrect');
    let next;try{next=assertPasswordPolicy(request.body.new_password)}catch(error){throw errors.badRequest('PASSWORD_POLICY',error.message)}
    const hash=await hashPassword(next);
    await client.query('UPDATE platform_users SET password_hash=$1,password_changed_at=now(),updated_at=now() WHERE id=$2',[hash,request.platformAuth.actorId]);
    const revoked=await client.query('UPDATE platform_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE platform_user_id=$1 AND id<>$2 AND revoked_at IS NULL',[request.platformAuth.actorId,request.platformAuth.sessionId]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.password.change',targetType:'platform_user',targetId:request.platformAuth.actorId,metadata:{other_sessions_revoked:revoked.rowCount},requestIp:request.ip,requestId:request.id});
    return {data:{changed:true,other_sessions_revoked:revoked.rowCount}};
  }));

  app.get('/v1/platform/me/sessions',{preHandler:[app.requirePlatformAuth]},async request=>{
    const rows=await app.db.query(`SELECT public_id AS id,user_agent,host(request_ip) AS request_ip,created_at,last_seen_at,expires_at,(id=$2) AS current FROM platform_sessions WHERE platform_user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY current DESC,last_seen_at DESC`,[request.platformAuth.actorId,request.platformAuth.sessionId]);
    return {data:{sessions:rows.rows}};
  });

  app.delete('/v1/platform/me/sessions/:sessionRef',{preHandler:[app.requirePlatformAuth]},async request=>app.db.transaction(async client=>{
    const row=await client.query('UPDATE platform_sessions SET revoked_at=COALESCE(revoked_at,now()),last_seen_at=now() WHERE platform_user_id=$1 AND public_id=$2 AND revoked_at IS NULL RETURNING id',[request.platformAuth.actorId,request.params.sessionRef]);
    if(!row.rowCount)throw errors.notFound('PLATFORM_SESSION_NOT_FOUND','Session not found');
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.session.revoke',targetType:'platform_session',targetId:row.rows[0].id,requestIp:request.ip,requestId:request.id});
    return {data:{revoked:true,current_session:row.rows[0].id===request.platformAuth.sessionId}};
  }));

  app.post('/v1/platform/me/sessions/revoke-others',{preHandler:[app.requirePlatformAuth]},async request=>app.db.transaction(async client=>{
    const row=await client.query('UPDATE platform_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE platform_user_id=$1 AND id<>$2 AND revoked_at IS NULL',[request.platformAuth.actorId,request.platformAuth.sessionId]);
    await writePlatformAudit(client,{actorId:request.platformAuth.actorId,action:'platform.sessions.revoke_others',targetType:'platform_user',targetId:request.platformAuth.actorId,metadata:{sessions_revoked:row.rowCount},requestIp:request.ip,requestId:request.id});
    return {data:{sessions_revoked:row.rowCount}};
  }));
}
