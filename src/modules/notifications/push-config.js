import { createECDH } from 'node:crypto';
import { isIP } from 'node:net';

const TRUTHY=new Set(['1','true','yes','on']);
const DEFAULT_HOST_SUFFIXES=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','notify.windows.com'];
const b64url=/^[A-Za-z0-9_-]+$/;
const bool=(name,fallback=false)=>{const raw=process.env[name];return raw==null||raw===''?fallback:TRUTHY.has(raw.trim().toLowerCase());};
const int=(name,fallback,min,max)=>{const raw=process.env[name];if(raw==null||raw==='')return fallback;const value=Number.parseInt(raw,10);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);return value;};
const decode=value=>Buffer.from(String(value||''),'base64url');

function verifyVapidPair(publicKey,privateKey){
 const expected=decode(publicKey),privateBytes=decode(privateKey);
 try{
  const ecdh=createECDH('prime256v1');
  ecdh.setPrivateKey(privateBytes);
  const derived=ecdh.getPublicKey(null,'uncompressed');
  if(!derived.equals(expected))throw new Error('mismatch');
 }catch{
  throw new Error('STAFF_WEB_PUSH_VAPID_PUBLIC_KEY and STAFF_WEB_PUSH_VAPID_PRIVATE_KEY must be a matching P-256 key pair');
 }
}

export function loadStaffPushConfig(){
 const enabled=bool('STAFF_WEB_PUSH_ENABLED',false);
 const publicKey=process.env.STAFF_WEB_PUSH_VAPID_PUBLIC_KEY?.trim()||'';
 const privateKey=process.env.STAFF_WEB_PUSH_VAPID_PRIVATE_KEY?.trim()||'';
 const subject=process.env.STAFF_WEB_PUSH_VAPID_SUBJECT?.trim()||'';
 const allowedHostSuffixes=(process.env.STAFF_WEB_PUSH_ALLOWED_HOST_SUFFIXES||DEFAULT_HOST_SUFFIXES.join(','))
  .split(',').map(value=>value.trim().toLowerCase().replace(/^\.+|\.+$/g,'')).filter(Boolean);
 const config={enabled,publicKey,privateKey,subject,allowedHostSuffixes,
  workerIntervalMs:int('STAFF_WEB_PUSH_WORKER_INTERVAL_MS',5000,1000,60000),
  batchSize:int('STAFF_WEB_PUSH_BATCH_SIZE',20,1,100),
  maxAttempts:int('STAFF_WEB_PUSH_MAX_ATTEMPTS',8,1,20),
  requestTimeoutMs:int('STAFF_WEB_PUSH_REQUEST_TIMEOUT_MS',10000,1000,30000),
  ttlSeconds:int('STAFF_WEB_PUSH_TTL_SECONDS',300,0,86400)};
 if(enabled){
  if(!publicKey||!privateKey||!subject)throw new Error('STAFF_WEB_PUSH_VAPID_PUBLIC_KEY, STAFF_WEB_PUSH_VAPID_PRIVATE_KEY, and STAFF_WEB_PUSH_VAPID_SUBJECT are required when STAFF_WEB_PUSH_ENABLED=true');
  if(!b64url.test(publicKey)||decode(publicKey).length!==65||decode(publicKey)[0]!==4)throw new Error('STAFF_WEB_PUSH_VAPID_PUBLIC_KEY must be an uncompressed P-256 public key encoded as base64url');
  if(!b64url.test(privateKey)||decode(privateKey).length!==32)throw new Error('STAFF_WEB_PUSH_VAPID_PRIVATE_KEY must be a 32-byte P-256 private key encoded as base64url');
  verifyVapidPair(publicKey,privateKey);
  if(!(subject.startsWith('mailto:')||subject.startsWith('https://')))throw new Error('STAFF_WEB_PUSH_VAPID_SUBJECT must use mailto: or https:');
  if(!allowedHostSuffixes.length)throw new Error('STAFF_WEB_PUSH_ALLOWED_HOST_SUFFIXES must not be empty when Staff Web push is enabled');
 }
 return Object.freeze(config);
}

export function validatePushEndpoint(raw,config=loadStaffPushConfig()){
 let url;try{url=new URL(String(raw||''));}catch{throw new Error('Push endpoint must be a valid absolute URL');}
 if(url.protocol!=='https:')throw new Error('Push endpoint must use HTTPS');
 if(url.username||url.password)throw new Error('Push endpoint must not contain credentials');
 if(url.port&&url.port!=='443')throw new Error('Push endpoint must use the default HTTPS port');
 const host=url.hostname.toLowerCase();
 if(!host||host==='localhost'||isIP(host))throw new Error('Push endpoint host is not allowed');
 const allowed=config.allowedHostSuffixes.some(suffix=>host===suffix||host.endsWith(`.${suffix}`));
 if(!allowed)throw new Error('Push endpoint host is not an approved Web Push provider');
 return url;
}
