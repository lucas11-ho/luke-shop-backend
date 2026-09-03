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
function calendarDate(value){if(!value)return null;if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);const match=String(value).match(/^\d{4}-\d{2}-\d{2}/);return match?match[0]:null;}

export function publicCustomer(row){return {id:row.public_id,customer_code:row.customer_code||row.public_id,display_name:row.display_name,email:row.email||null,phone_e164:row.phone_e164||null,avatar_url:row.avatar_url||null,birth_date:calendarDate(row.birth_date),status:row.status};}

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
  return {
    google:Boolean(config.customerGoogleClientId),telegram:telegramModern||telegramLegacy,
    telegram_mode:telegramModern?'OIDC_LIBRARY':(telegramLegacy?'LEGACY_WIDGET':null),
    phone:Boolean(config.customerPhoneOtpWebhookUrl&&config.customerPhoneOtpHashSecret),turnstile:Boolean(config.turnstileSecretKey),
    password_reset:false,
  };
}

export function effectiveAuthOptions(settings,config){
  const stored=settings?.auth_config&&typeof settings.auth_config==='object'?settings.auth_config:{};const ready=providerReadiness(config);
  const methods=stored.methods&&typeof stored.methods==='object'?stored.methods:{};
  return {
    methods:{
      email_password:{enabled:methods.email_password?.enabled!==false},
      google:{enabled:Boolean(ready.google&&methods.google?.enabled!==false)},
      telegram:{enabled:Boolean(ready.telegram&&methods.telegram?.enabled!==false),mode:ready.telegram_mode},
      phone:{enabled:Boolean(ready.phone&&methods.phone?.enabled!==false),countries:Array.isArray(methods.phone?.countries)&&methods.phone.countries.length?methods.phone.countries:DEFAULT_PHONE_COUNTRIES},
    },
    turnstile:{ready:ready.turnstile,login_required:Boolean(ready.turnstile&&stored.turnstile?.login_required),signup_required:Boolean(ready.turnstile&&stored.turnstile?.signup_required),social_required:Boolean(ready.turnstile&&stored.turnstile?.social_required),site_key:ready.turnstile?(config.turnstileSiteKey||null):null},
    readiness:ready,
  };
}

export async function assertCustomerTurnstile(config,token,request,action='auth'){
  if(!config.turnstileSecretKey)return;
  if(!token)throw errors.badRequest('TURNSTILE_REQUIRED','Complete the security check');
  const body=new URLSearchParams({secret:config.turnstileSecretKey,response:String(token)});if(request.ip)body.set('remoteip',request.ip);
  let res;try{res=await fetch(TURNSTILE_SITEVERIFY,{method:'POST',body,headers:{'Content-Type':'application/x-www-form-urlencoded'}});}catch{throw errors.unavailable('TURNSTILE_UNAVAILABLE','Security verification is temporarily unavailable');}
  let data;try{data=await res.json();}catch{data=null;}if(!res.ok||!data?.success)throw errors.unauthorized('TURNSTILE_INVALID','Security verification failed');
  if(data.action&&data.action!==action)throw errors.unauthorized('TURNSTILE_ACTION_INVALID','Security verification action mismatch');
}

export function normalizePhone(callingCode,phone){const cc=String(callingCode||'').replace(/[^0-9]/g,''),local=String(phone||'').replace(/[^0-9]/g,'').replace(/^0+/,'');if(!cc||!local)throw errors.badRequest('PHONE_INVALID','Enter a valid calling code and phone number');const value=`+${cc}${local}`;if(value.length<8||value.length>18)throw errors.badRequest('PHONE_INVALID','Phone number is invalid');return value;}
export function newOtp(){return String(randomInt(0,1000000)).padStart(6,'0');}
export function otpHash(secret,challengeId,phone,code){return createHmac('sha256',secret).update(`${challengeId}:${phone}:${code}`).digest('hex');}

export async function findOrCreateProviderCustomer(app,client,{tenantId,provider,subject,displayName,email=null,phone=null,avatarUrl=null,metadata={},allowEmailAutoLink=false,request}){
  const existing=await client.query(`SELECT c.* FROM customer_auth_identities i JOIN customers c ON c.id=i.customer_id AND c.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.provider=$2 AND i.provider_subject=$3`,[tenantId,provider,subject]);
  if(existing.rowCount)return existing.rows[0];
  let customer=null;
  if(email&&allowEmailAutoLink){const byEmail=await client.query('SELECT * FROM customers WHERE tenant_id=$1 AND email=$2',[tenantId,normalizeEmail(email)]);if(byEmail.rowCount)customer=byEmail.rows[0];}
  if(!customer&&phone){const byPhone=await client.query('SELECT * FROM customers WHERE tenant_id=$1 AND phone_e164=$2',[tenantId,phone]);if(byPhone.rowCount)customer=byPhone.rows[0];}
  if(!customer){
    const id=uuid(),pid=publicId('cus'),code=await allocateCustomerCode(client,tenantId);
    const inserted=await client.query(`INSERT INTO customers(id,public_id,tenant_id,email,phone_e164,avatar_url,display_name,status,customer_sequence,customer_code) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9) RETURNING *`,[id,pid,tenantId,email?normalizeEmail(email):null,phone,avatarUrl,displayName||'Customer',code.sequence,code.code]);customer=inserted.rows[0];
    await client.query(`INSERT INTO customer_status_history(tenant_id,customer_id,from_status,to_status,reason,changed_by_type) VALUES($1,$2,NULL,'ACTIVE',$3,'SYSTEM')`,[tenantId,id,`${provider} registration`]);
  }
  await client.query(`INSERT INTO customer_auth_identities(id,public_id,tenant_id,customer_id,provider,provider_subject,email,phone_e164,avatar_url,metadata,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now())`,[uuid(),publicId('cid'),tenantId,customer.id,provider,subject,email?normalizeEmail(email):null,phone,avatarUrl,JSON.stringify(metadata||{})]);
  if(phone&&!customer.phone_e164)await client.query('UPDATE customers SET phone_e164=$1,updated_at=now() WHERE id=$2',[phone,customer.id]);
  if(avatarUrl&&!customer.avatar_url)await client.query('UPDATE customers SET avatar_url=$1,updated_at=now() WHERE id=$2',[avatarUrl,customer.id]);
  await writeAudit(client,{tenantId,actorType:'CUSTOMER',actorId:customer.id,action:'customer.auth_identity.link',targetType:'customer',targetId:customer.id,metadata:{provider},requestIp:request.ip,requestId:request.id});
  return (await client.query('SELECT * FROM customers WHERE id=$1',[customer.id])).rows[0];
}

export async function verifyGoogleCredential(config,credential){
  if(!config.customerGoogleClientId)throw errors.unavailable('GOOGLE_LOGIN_NOT_CONFIGURED','Google login is not configured');
  let payload;try{const result=await jwtVerify(credential,GOOGLE_JWKS,{issuer:['https://accounts.google.com','accounts.google.com'],audience:config.customerGoogleClientId});payload=result.payload;}catch{throw errors.unauthorized('GOOGLE_TOKEN_INVALID','Google sign-in token is invalid');}
  if(!payload.sub||!payload.email||payload.email_verified!==true)throw errors.unauthorized('GOOGLE_PROFILE_INVALID','Google account must have a verified email');return payload;
}
export function googleEmailMayAutoLink(profile){return Boolean(profile?.email_verified===true);}

export function issueTelegramNonce(config,tenantId){if(!config.customerTelegramLoginSigningSecret)throw errors.unavailable('TELEGRAM_LOGIN_NOT_CONFIGURED','Telegram login signing secret is missing');const nonce=b64url(randomBytes(24)),exp=Math.floor(Date.now()/1000)+600,payload=`${tenantId}.${exp}.${nonce}`,sig=createHmac('sha256',config.customerTelegramLoginSigningSecret).update(payload).digest('base64url');return `${payload}.${sig}`;}
export function verifyTelegramNonce(config,value,tenantId){const parts=String(value||'').split('.');if(parts.length!==4)throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram login state is invalid');const[t,e,n,s]=parts,exp=Number(e);if(t!==tenantId||!Number.isFinite(exp)||exp<Math.floor(Date.now()/1000))throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram login state expired');const expected=createHmac('sha256',config.customerTelegramLoginSigningSecret).update(`${t}.${e}.${n}`).digest('base64url');if(!safeEqualText(expected,s))throw errors.unauthorized('TELEGRAM_NONCE_INVALID','Telegram login state is invalid');return n;}
export async function verifyTelegramIdToken(config,idToken,nonceValue){if(!config.customerTelegramClientId)throw errors.unavailable('TELEGRAM_LOGIN_NOT_CONFIGURED','Telegram modern login is not configured');const rawNonce=verifyTelegramNonce(config,nonceValue,arguments[3]||'');let payload;try{const result=await jwtVerify(idToken,TELEGRAM_JWKS,{audience:config.customerTelegramClientId});payload=result.payload;}catch{throw errors.unauthorized('TELEGRAM_TOKEN_INVALID','Telegram ID token is invalid');}if(!payload.sub||payload.nonce!==rawNonce)throw errors.unauthorized('TELEGRAM_TOKEN_INVALID','Telegram ID token nonce is invalid');return payload;}
export function verifyTelegramPayload(config,body){if(!config.customerTelegramBotToken)throw errors.unavailable('TELEGRAM_LOGIN_NOT_CONFIGURED','Telegram legacy login is not configured');const data={...body};const hash=String(data.hash||'');delete data.hash;const check=Object.keys(data).filter(k=>data[k]!==undefined&&data[k]!==null).sort().map(k=>`${k}=${data[k]}`).join('\n'),secret=createHash('sha256').update(config.customerTelegramBotToken).digest(),expected=createHmac('sha256',secret).update(check).digest('hex');if(!safeEqualText(hash,expected))throw errors.unauthorized('TELEGRAM_SIGNATURE_INVALID','Telegram login data is invalid');const authDate=Number(data.auth_date);if(!Number.isFinite(authDate)||Math.abs(Math.floor(Date.now()/1000)-authDate)>600)throw errors.unauthorized('TELEGRAM_AUTH_EXPIRED','Telegram login data expired');return data;}
