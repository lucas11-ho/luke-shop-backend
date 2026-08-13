import { errors } from '../../core/errors.js';
import { verifyPlatformAccessToken } from '../../core/tokens.js';

function bearer(request){
  const value=request.headers.authorization;
  if(!value||!value.startsWith('Bearer ')) throw errors.unauthorized();
  return value.slice(7).trim();
}

export function platformAuthPlugin(app){
  app.decorateRequest('platformAuth',null);
  app.decorate('requirePlatformAuth',async function requirePlatformAuth(request){
    let payload;
    try{payload=await verifyPlatformAccessToken(app.config,bearer(request));}
    catch{throw errors.unauthorized('PLATFORM_ACCESS_TOKEN_INVALID','Invalid or expired platform access token');}
    const found=await app.db.query(
      `SELECT u.id,u.public_id,u.email,u.display_name,u.role,u.status,s.id AS session_id
         FROM platform_sessions s JOIN platform_users u ON u.id=s.platform_user_id
        WHERE s.id=$1 AND u.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'`,
      [payload.session_id,payload.sub],
    );
    if(!found.rowCount) throw errors.unauthorized('PLATFORM_SESSION_INVALID','Platform session is no longer active');
    request.platformAuth={actorId:found.rows[0].id,sessionId:found.rows[0].session_id,role:found.rows[0].role,profile:found.rows[0]};
  });
  app.decorate('requirePlatformOwner',async function requirePlatformOwner(request){
    if(request.platformAuth?.role!=='OWNER') throw errors.forbidden('PLATFORM_OWNER_REQUIRED','Platform Owner access required');
  });
}
