import { createCipheriv,createECDH,hkdfSync,randomBytes } from 'node:crypto';
import { importJWK,SignJWT } from 'jose';
import { validatePushEndpoint } from './push-config.js';

const b64urlToBuffer=value=>Buffer.from(String(value||''),'base64url');
const bufferToB64url=value=>Buffer.from(value).toString('base64url');
const hkdf=(ikm,salt,info,length)=>Buffer.from(hkdfSync('sha256',Buffer.from(ikm),Buffer.from(salt),Buffer.from(info),length));

function vapidJwk(config){
 const pub=b64urlToBuffer(config.publicKey),priv=b64urlToBuffer(config.privateKey);
 return {kty:'EC',crv:'P-256',x:bufferToB64url(pub.subarray(1,33)),y:bufferToB64url(pub.subarray(33,65)),d:bufferToB64url(priv),ext:true};
}

async function vapidToken(endpoint,config){
 const audience=new URL(endpoint);audience.pathname='/';audience.search='';audience.hash='';
 const key=await importJWK(vapidJwk(config),'ES256');
 return new SignJWT({sub:config.subject})
  .setProtectedHeader({alg:'ES256',typ:'JWT'})
  .setAudience(audience.origin)
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now()/1000)+12*60*60)
  .sign(key);
}

function encryptPayload(subscription,payload){
 const clientPublic=b64urlToBuffer(subscription.p256dh),auth=b64urlToBuffer(subscription.auth_secret);
 if(clientPublic.length!==65||clientPublic[0]!==4)throw new Error('Invalid subscription p256dh key');
 if(auth.length<16)throw new Error('Invalid subscription auth secret');
 const ecdh=createECDH('prime256v1');ecdh.generateKeys();
 const serverPublic=ecdh.getPublicKey(null,'uncompressed');
 const shared=ecdh.computeSecret(clientPublic);
 const info=Buffer.concat([Buffer.from('WebPush: info\0','utf8'),clientPublic,serverPublic]);
 const ikm=hkdf(shared,auth,info,32),salt=randomBytes(16);
 const cek=hkdf(ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0','utf8'),16);
 const nonce=hkdf(ikm,salt,Buffer.from('Content-Encoding: nonce\0','utf8'),12);
 const plain=Buffer.concat([Buffer.from(JSON.stringify(payload),'utf8'),Buffer.from([2])]);
 const cipher=createCipheriv('aes-128-gcm',cek,nonce),encrypted=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
 const recordSize=Buffer.alloc(4);recordSize.writeUInt32BE(4096,0);
 return Buffer.concat([salt,recordSize,Buffer.from([serverPublic.length]),serverPublic,encrypted]);
}

export async function sendWebPush(subscription,payload,config){
 const endpoint=validatePushEndpoint(subscription.endpoint,config),body=encryptPayload(subscription,payload),jwt=await vapidToken(endpoint,config);
 let response;
 try{
  response=await fetch(endpoint,{method:'POST',body,signal:AbortSignal.timeout(config.requestTimeoutMs),headers:{
   'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream','TTL':String(config.ttlSeconds),'Urgency':'normal',
   'Authorization':`vapid t=${jwt}, k=${config.publicKey}`,
  }});
 }catch(error){return{kind:'TRANSIENT',status:null,error:error?.name==='TimeoutError'?'PUSH_TIMEOUT':'PUSH_NETWORK_ERROR'};}
 if(response.status===201||response.status===202)return{kind:'DELIVERED',status:response.status,error:null};
 if(response.status===404||response.status===410)return{kind:'EXPIRED',status:response.status,error:'PUSH_SUBSCRIPTION_EXPIRED'};
 if(response.status===429||response.status>=500)return{kind:'TRANSIENT',status:response.status,error:`PUSH_PROVIDER_${response.status}`};
 return{kind:'PERMANENT',status:response.status,error:`PUSH_PROVIDER_${response.status}`};
}
