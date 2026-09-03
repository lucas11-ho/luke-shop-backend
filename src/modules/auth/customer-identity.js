import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { errors } from '../../core/errors.js';
import { publicId, uuid, normalizeEmail } from '../../core/identifiers.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../core/tokens.js';
import { writeAudit } from '../../core/audit.js';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const TELEGRAM_JWKS = createRemoteJWKSet(new URL('https://oauth.telegram.org/.well-known/jwks.json'));
const TURNSTILE_SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const DEFAULT_PHONE_COUNTRIES = ['KH','IN','MM','ID','PH','TH','VN','MY','SG'];

function b64url(value){return Buffer.from(value).toString('base64url');}
function safeEqualText(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&timingSafeEqual(aa,bb);}

export function publicCustomer(row){return {id:row.public_id,customer_code:row.customer_code||row.public_id,display_name:row.display_name,email:row.email||null,phone_e164:row.phone_e164||null,avatar_url:row.avatar_url||null,birth_date:row.birth_date||null,status:row.status};}

export async function allocateCustomerCode(client,tenantId){
  const r=await client.query(`UPDATE tenant_customer_identity_settings SET next_sequence=next_sequence+1,updated_at=now() WHERE tenant_id=$1 RETURNING id_prefix,next_sequence-1 AS sequence`,[tenantId]);
  if(!r.rowCount)throw errors.conflict('CUSTOMER_IDENTITY_SETTINGS_MISSING','Customer identity settings are missing');
  const seq=Number(r.rows[0].sequence);
  return {sequence:seq,code:`${r.rows[0].id_prefix}${String(seq).padStart(7,'0')}`};
}

export async function createCustomerSession(app,client,tenantId,customerId,request){
  const refreshToken=newRefreshToken(),sessionId=uuid();
  await client.query(`INSERT INTO customer_sessions(id,tenant_id,customer_id,refresh_token_hash,expires_at,user_agent,request_ip) VALUES($1,$2,$3,$4,now()+($5::text||' days')::interval,$6,$7)`,[sessionId,tenantId,customerId,hashRefreshToken(refreshToken),app.config.refreshTokenTtlDays,request.headers['user-agent']||null,request.ip||null]);
  const access=await signAccessToken(app.config,{subject:customerId,tenantId,actorType:'CUSTOMER',sessionId});
  return {access_token:access.token,expires_in:access.expiresIn,refresh_token:refreshToken};
}

export async function customerIdentitySettings(db,tenantId){
  const r=await db.query(`SELECT id_prefix,next_sequence,auth_config FROM tenant_customer_identity_settings WHERE tenant_id=$1`,[tenantId]);
  if(!r.rowCount)throw errors.conflict('CUSTOMER_IDENTITY_SETTINGS_MISSING','Customer identity settings are missing');
  return r.rows[0];
}

export function providerReadiness(config){
  const telegramModern=Boolean(config.customerTelegramClientId);
  const telegramLegacy=Boolean(config.customerTelegramBotUsername&&config.customerTelegramBotToken);
  const turnstile=Boolean(config.customerTurnstileEnabled&&config.customerTurnstileSiteKey&&config.customerTurnstileSecretKey);
  return {
    email_password:true,
    google:Boolean(config.customerGoogleClientId),
    telegram:Boolean(telegramModern||telegramLegacy),
    telegram_modern:telegramModern,
    telegram_legacy:telegramLegacy,
    phone:Boolean(config.customerPhoneOtpWebhookUrl&&config.customerPhoneOtpHashSecret),
    turnstile,
  };
}

export function effectiveAuthOptions(settings,config){
  const requested=settings.auth_config||{},ready=providerReadiness(config);
  const turnstileReady=ready.turnstile;
  return {
    id_prefix:settings.id_prefix,
    turnstile:{
      enabled:Boolean(config.customerTurnstileEnabled&&turnstileReady),
      ready:turnstileReady,
      site_key:turnstileReady?config.customerTurnstileSiteKey:null,
      login_required:Boolean(config.customerTurnstileEnabled&&(requested.turnstile_login_required??config.customerTurnstileLoginRequired)),
      signup_required:Boolean(config.customerTurnstileEnabled&&(requested.turnstile_signup_required??config.customerTurnstileSignupRequired)),
      social_required:Boolean(config.customerTurnstileEnabled&&(requested.turnstile_social_required??config.customerTurnstileSocialRequired)),
    },
    methods:{
      email_password:{enabled:requested.email_password!==false,ready:true},
      google:{enabled:Boolean(requested.google&&ready.google),requested:Boolean(requested.google),ready:ready.google,client_id:ready.google?config.customerGoogleClientId:null},
      telegram:{
        enabled:Boolean(requested.telegram&&ready.telegram),requested:Boolean(requested.telegram),ready:ready.telegram,
        mode:ready.telegram_modern?'OIDC_LIBRARY':ready.telegram_legacy?'LEGACY_WIDGET':'UNCONFIGURED',
        client_id:ready.telegram_modern?config.customerTelegramClientId:null,
        bot_username:config.customerTelegramBotUsername||null,
      },
      phone:{enabled:Boolean(requested.phone&&ready.phone),requested:Boolean(requested.phone),ready:ready.phone,countries:Array.isArray(requested.phone_countries)?requested.phone_countries:DEFAULT_PHONE_COUNTRIES},
    },
  };
}

async function createExternalCustomer(app,client,{tenantId,provider,subject,displayName,email=null,phone=null,countryCode=null,avatarUrl=null,metadata={},request}){
  const code=await allocateCustomerCode(client,tenantId);const id=uuid(),pid=publicId('cus');
  const row=(await client.query(`INSERT INTO customers(id,public_id,tenant_id,email,password_hash,display_name,status,customer_sequence,customer_code,phone_e164,phone_country_code,avatar_url,email_verified_at,phone_verified_at) VALUES($1,$2,$3,$4,NULL,$5,'ACTIVE',$6,$7,$8,$9,$10,CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END) RETURNING *`,[id,pid,tenantId,email,displayName||'Customer',code.sequence,code.code,phone,countryCode,avatarUrl])).rows[0];
  await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,email,phone_e164,metadata,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())`,[uuid(),publicId('cid'),tenantId,id,provider,subject,email,phone,JSON.stringify(metadata||{})]);
  await client.query(`INSERT INTO customer_status_history(tenant_id,customer_id,from_status,to_status,reason,changed_by_type) VALUES($1,$2,NULL,'ACTIVE',$3,'CUSTOMER')`,[tenantId,id,`${provider.toLowerCase()} registration`]);
  await writeAudit(client,{tenantId,actorType:'CUSTOMER',actorId:id,action:'customer.external_register',targetType:'customer',targetId:id,metadata:{provider},requestIp:request.ip,requestId:request.id});
  return row;
}

export async function findOrCreateProviderCustomer(app,client,{tenantId,provider,subject,displayName,email=null,phone=null,countryCode=null,avatarUrl=null,metadata={},request,allowEmailAutoLink=true}){
  let identity=(await client.query(`SELECT c.* FROM customer_auth_identities i JOIN customers c ON c.id=i.customer_id AND c.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.provider=$2 AND i.provider_subject=$3 FOR UPDATE OF c`,[tenantId,provider,subject])).rows[0];
  if(identity)return identity;
  let existing=null;
  if(email)existing=(await client.query(`SELECT * FROM customers WHERE tenant_id=$1 AND email=$2 FOR UPDATE`,[tenantId,normalizeEmail(email)])).rows[0]||null;
  if(existing&&email&&!allowEmailAutoLink)throw errors.conflict('ACCOUNT_LINK_REQUIRED','An account already exists for this email. Sign in with your existing method, then connect this provider from Login & Security.');
  if(!existing&&phone)existing=(await client.query(`SELECT * FROM customers WHERE tenant_id=$1 AND phone_e164=$2 FOR UPDATE`,[tenantId,phone])).rows[0]||null;
  if(existing){
    await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,email,phone_e164,metadata,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()) ON CONFLICT(tenant_id,customer_id,provider) DO UPDATE SET provider_subject=EXCLUDED.provider_subject,email=COALESCE(EXCLUDED.email,customer_auth_identities.email),phone_e164=COALESCE(EXCLUDED.phone_e164,customer_auth_identities.phone_e164),metadata=EXCLUDED.metadata,verified_at=now(),updated_at=now()`,[uuid(),publicId('cid'),tenantId,existing.id,provider,subject,email,phone,JSON.stringify(metadata||{})]);
    if(phone&&!existing.phone_e164)await client.query(`UPDATE customers SET phone_e164=$1,phone_country_code=$2,phone_verified_at=now(),updated_at=now() WHERE id=$3`,[phone,countryCode,existing.id]);
    if(avatarUrl&&!existing.avatar_url)await client.query(`UPDATE customers SET avatar_url=$1,updated_at=now() WHERE id=$2`,[avatarUrl,existing.id]);
    return (await client.query(`SELECT * FROM customers WHERE id=$1`,[existing.id])).rows[0];
  }
  return createExternalCustomer(app,client,{tenantId,provider,subject,displayName,email:email?normalizeEmail(email):null,phone,countryCode,avatarUrl,metadata,request});
}

export async function verifyGoogleCredential(config,credential){
  if(!config.customerGoogleClientId)throw errors.unavailable('GOOGLE_LOGIN_NOT_CONFIGURED','Google login is not configured');
  try{
    const {payload}=await jwtVerify(credential,GOOGLE_JWKS,{audience:config.customerGoogleClientId,issuer:['https://accounts.google.com','accounts.google.com']});
    if(!payload.sub||!payload.email||payload.email_verified!==true)throw new Error('Google email is not verified');
    return payload;
  }catch{throw errors.unauthorized('GOOGLE_LOGIN_INVALID','Google sign-in could not be verified');}
}

export function googleEmailMayAutoLink(profile){
  const email=String(profile?.email||'').toLowerCase();
  return email.endsWith('@gmail.com')||Boolean(profile?.hd);
}

export function issueTelegramNonce(config,tenantId){
  const payload={tenant_id:String(tenantId),iat:Math.floor(Date.now()/1000),r:randomBytes(18).toString('base64url')};
  const body=b64url(JSON.stringify(payload));
  const sig=createHmac('sha256',config.jwtAccessSecret).update(`telegram-login|${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyTelegramNonce(config,nonce,tenantId){
  const [body,sig,...rest]=String(nonce||'').split('.');
  if(!body||!sig||rest.length)throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram sign-in session is invalid or expired');
  const expected=createHmac('sha256',config.jwtAccessSecret).update(`telegram-login|${body}`).digest('base64url');
  if(!safeEqualText(sig,expected))throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram sign-in session is invalid or expired');
  let payload;try{payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram sign-in session is invalid or expired');}
  const age=Math.floor(Date.now()/1000)-Number(payload.iat||0);
  if(String(payload.tenant_id)!==String(tenantId)||age<0||age>600)throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram sign-in session is invalid or expired');
  return payload;
}

export async function verifyTelegramIdToken(config,idToken,expectedNonce){
  if(!config.customerTelegramClientId)throw errors.unavailable('TELEGRAM_LOGIN_NOT_CONFIGURED','Telegram modern login is not configured');
  try{
    const {payload}=await jwtVerify(idToken,TELEGRAM_JWKS,{audience:config.customerTelegramClientId,issuer:'https://oauth.telegram.org',algorithms:['RS256','ES256']});
    if(!payload.sub)throw new Error('Missing Telegram subject');
    if(expectedNonce&&!safeEqualText(payload.nonce,expectedNonce))throw new Error('Telegram nonce mismatch');
    return payload;
  }catch{throw errors.unauthorized('TELEGRAM_LOGIN_INVALID','Telegram sign-in could not be verified');}
}

// Legacy Telegram Login Widget verification is kept only as a compatibility fallback.
export function verifyTelegramPayload(config,payload){
  if(!config.customerTelegramBotToken)throw errors.unavailable('TELEGRAM_LOGIN_NOT_CONFIGURED','Telegram login is not configured');
  const data={...payload};const supplied=String(data.hash||'');delete data.hash;const authDate=Number(data.auth_date||0);
  if(!authDate||Math.abs(Math.floor(Date.now()/1000)-authDate)>600)throw errors.unauthorized('TELEGRAM_LOGIN_EXPIRED','Telegram sign-in data expired');
  const check=Object.keys(data).filter(k=>data[k]!==undefined&&data[k]!==null&&data[k]!=='').sort().map(k=>`${k}=${data[k]}`).join('\n');
  const secret=createHash('sha256').update(config.customerTelegramBotToken).digest();const expected=createHmac('sha256',secret).update(check).digest('hex');
  const a=Buffer.from(supplied,'hex'),b=Buffer.from(expected,'hex');
  if(a.length!==b.length||!timingSafeEqual(a,b))throw errors.unauthorized('TELEGRAM_LOGIN_INVALID','Telegram sign-in could not be verified');
  return data;
}

export async function assertCustomerTurnstile(config,token,request,expectedAction){
  if(!config.customerTurnstileEnabled)return {success:true,skipped:true};
  const value=String(token||'').trim();
  if(!value||value.length>2048)throw errors.badRequest('TURNSTILE_REQUIRED','Complete the Cloudflare security verification and try again');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  let response,result;
  try{
    response=await fetch(TURNSTILE_SITEVERIFY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:config.customerTurnstileSecretKey,response:value,remoteip:request.ip||undefined,idempotency_key:uuid()}),signal:controller.signal});
    if(!response.ok)throw new Error(`Siteverify HTTP ${response.status}`);
    result=await response.json();
  }catch(error){
    throw errors.unavailable('TURNSTILE_UNAVAILABLE','Security verification is temporarily unavailable. Please try again.');
  }finally{clearTimeout(timer);}
  if(!result?.success)throw errors.unauthorized('TURNSTILE_INVALID','Security verification failed. Please refresh the verification and try again.');
  if(expectedAction&&result.action!==expectedAction)throw errors.unauthorized('TURNSTILE_ACTION_MISMATCH','Security verification could not be matched to this action. Please try again.');
  const hostname=String(result.hostname||'').toLowerCase();
  if(config.customerTurnstileHostnames.length&&!config.customerTurnstileHostnames.includes(hostname))throw errors.unauthorized('TURNSTILE_HOSTNAME_MISMATCH','Security verification came from an untrusted storefront hostname.');
  return {success:true,hostname,action:result.action||null};
}

export function normalizePhone(countryCallingCode,nationalNumber){
  const cc=String(countryCallingCode||'').replace(/\D/g,'');let n=String(nationalNumber||'').replace(/\D/g,'').replace(/^0+/,'');
  if(!cc||cc.length>4||!n||n.length<5||n.length>14)throw errors.badRequest('PHONE_INVALID','Enter a valid country code and phone number');
  const phone=`+${cc}${n}`;if(phone.length<8||phone.length>16)throw errors.badRequest('PHONE_INVALID','Enter a valid phone number');return phone;
}
export function otpHash(secret,challengeId,phone,code){return createHmac('sha256',secret).update(`${challengeId}|${phone}|${code}`).digest('hex');}
export function newOtp(){return String(randomInt(0,1000000)).padStart(6,'0');}
