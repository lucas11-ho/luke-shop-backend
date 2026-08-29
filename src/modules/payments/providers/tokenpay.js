import crypto from 'node:crypto';
import { errors } from '../../../core/errors.js';

export const TOKENPAY_PROVIDER_KEY='TOKENPAY';
export const TOKENPAY_API_BASE='https://api.tokenpay.me';
export const TOKENPAY_PREPAY_PATH='/v1/transaction/prepayment';

function appSecretKey(appSecret){
  const key=Buffer.from(String(appSecret||''),'utf8');
  if(key.length!==32) throw errors.badRequest('TOKENPAY_APP_SECRET_INVALID','TokenPay App Secret must be exactly 32 bytes');
  return key;
}

function safeEqual(a,b){
  const left=Buffer.from(String(a||''),'utf8'),right=Buffer.from(String(b||''),'utf8');
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}

function sha256(value){return crypto.createHash('sha256').update(String(value??''),'utf8').digest('hex');}

function rawTopLevelObjectProperty(json,key){
  const source=String(json||'');
  let i=0,depth=0;
  while(i<source.length){
    const ch=source[i];
    if(ch==='{'){depth++;i++;continue;}
    if(ch==='}'){depth--;i++;continue;}
    if(ch!=='"'){i++;continue;}
    const tokenStart=i;
    i++;
    let escaped=false;
    while(i<source.length){
      const c=source[i++];
      if(escaped){escaped=false;continue;}
      if(c==='\\'){escaped=true;continue;}
      if(c==='"') break;
    }
    const token=source.slice(tokenStart,i);
    let decoded='';
    try{decoded=JSON.parse(token);}catch{continue;}
    if(depth!==1||decoded!==key) continue;
    let j=i;
    while(/\s/.test(source[j]||''))j++;
    if(source[j++]!==':') continue;
    while(/\s/.test(source[j]||''))j++;
    if(source[j]!=='{') return null;
    const start=j,stack=[];
    let inString=false,stringEscape=false;
    for(;j<source.length;j++){
      const c=source[j];
      if(inString){
        if(stringEscape)stringEscape=false;
        else if(c==='\\')stringEscape=true;
        else if(c==='"')inString=false;
        continue;
      }
      if(c==='"'){inString=true;continue;}
      if(c==='{')stack.push('}');
      else if(c==='[')stack.push(']');
      else if(stack.length&&c===stack[stack.length-1]){
        stack.pop();
        if(stack.length===0)return source.slice(start,j+1);
      }
    }
    return null;
  }
  return null;
}

export function tokenPayNonce(){return crypto.randomBytes(16).toString('hex');}

export function tokenPayRequestPlaintext({path,timestamp,nonce,body}){
  return `${path}\n${timestamp}\n${nonce}\n${body}`;
}

export function tokenPayResponsePlaintext({timestamp,nonce,body}){
  return `${timestamp}\n${nonce}\n${body}`;
}

export function tokenPayEncryptSignature(plaintext,appSecret){
  const cipher=crypto.createCipheriv('aes-256-ecb',appSecretKey(appSecret),null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(String(plaintext),'utf8'),cipher.final()]).toString('base64');
}

export function signTokenPayRequest({path,timestamp,nonce,body,appSecret}){
  return tokenPayEncryptSignature(tokenPayRequestPlaintext({path,timestamp,nonce,body}),appSecret);
}

export function verifyTokenPayMessage({timestamp,nonce,body,signature,appSecret}){
  if(!timestamp||!nonce||!signature||typeof body!=='string') return false;
  const expected=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body}),appSecret);
  return safeEqual(expected,signature);
}

export function verifyTokenPayResponse({timestamp,nonce,rawBody,signature,appSecret}){
  if(!timestamp||!nonce||!signature||typeof rawBody!=='string') return {ok:false,mode:null,canonicalBody:null,rawDataBody:null,dataBody:null};
  if(verifyTokenPayMessage({timestamp,nonce,body:rawBody,signature,appSecret})) return {ok:true,mode:'RAW',canonicalBody:null,rawDataBody:null,dataBody:null};
  let parsed;
  try{parsed=JSON.parse(rawBody);}catch{return {ok:false,mode:null,canonicalBody:null,rawDataBody:null,dataBody:null};}
  const canonicalBody=JSON.stringify(parsed);
  if(canonicalBody!==rawBody&&verifyTokenPayMessage({timestamp,nonce,body:canonicalBody,signature,appSecret})){
    return {ok:true,mode:'CANONICAL_JSON',canonicalBody,rawDataBody:null,dataBody:null};
  }
  const rawDataBody=rawTopLevelObjectProperty(rawBody,'data');
  if(typeof rawDataBody==='string'&&verifyTokenPayMessage({timestamp,nonce,body:rawDataBody,signature,appSecret})){
    return {ok:true,mode:'RAW_DATA_JSON',canonicalBody,rawDataBody,dataBody:null};
  }
  const dataBody=parsed&&typeof parsed==='object'&&parsed.data!==undefined?JSON.stringify(parsed.data):null;
  if(typeof dataBody==='string'&&verifyTokenPayMessage({timestamp,nonce,body:dataBody,signature,appSecret})){
    return {ok:true,mode:'DATA_JSON',canonicalBody,rawDataBody,dataBody};
  }
  return {ok:false,mode:null,canonicalBody,rawDataBody,dataBody};
}

export function tokenPayResponseSignatureDiagnostic({response,timestamp,nonce,body,signature,appSecret,canonicalBody=null,rawDataBody=null,dataBody=null}){
  let expected='',canonicalExpected='',rawDataExpected='',dataExpected='';
  if(timestamp&&nonce&&signature&&typeof body==='string'){
    expected=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body}),appSecret);
    if(typeof canonicalBody==='string') canonicalExpected=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body:canonicalBody}),appSecret);
    if(typeof rawDataBody==='string') rawDataExpected=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body:rawDataBody}),appSecret);
    if(typeof dataBody==='string') dataExpected=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body:dataBody}),appSecret);
  }
  const headerNames=[];
  try{for(const [name] of response?.headers?.entries?.()||[])headerNames.push(String(name).toLowerCase());}catch{}
  return {
    status:Number(response?.status||0),
    timestamp_present:Boolean(timestamp),timestamp_length:String(timestamp||'').length,
    nonce_present:Boolean(nonce),nonce_length:String(nonce||'').length,
    signature_present:Boolean(signature),signature_length:String(signature||'').length,
    body_bytes:Buffer.byteLength(String(body||''),'utf8'),body_sha256:sha256(body),
    canonical_body_bytes:typeof canonicalBody==='string'?Buffer.byteLength(canonicalBody,'utf8'):0,
    canonical_body_sha256:typeof canonicalBody==='string'?sha256(canonicalBody):'',
    raw_data_body_bytes:typeof rawDataBody==='string'?Buffer.byteLength(rawDataBody,'utf8'):0,
    raw_data_body_sha256:typeof rawDataBody==='string'?sha256(rawDataBody):'',
    data_body_bytes:typeof dataBody==='string'?Buffer.byteLength(dataBody,'utf8'):0,
    data_body_sha256:typeof dataBody==='string'?sha256(dataBody):'',
    expected_signature_sha256:expected?sha256(expected):'',
    canonical_expected_signature_sha256:canonicalExpected?sha256(canonicalExpected):'',
    raw_data_expected_signature_sha256:rawDataExpected?sha256(rawDataExpected):'',
    data_expected_signature_sha256:dataExpected?sha256(dataExpected):'',
    received_signature_sha256:signature?sha256(signature):'',
    response_header_names:[...new Set(headerNames)].sort(),
  };
}

export function buildTokenPayAuthorization({appId,mchId,timestamp,nonce,signature}){
  return `TTPAY-AES-256-ECB app_id=${appId},mch_id=${mchId},nonce_str=${nonce},timestamp=${timestamp},signature=${signature}`;
}

export function decryptTokenPayResource(resource,appSecret){
  if(!resource||resource.algorithm!=='AEAD_AES_256_GCM'||!resource.ciphertext||!resource.nonce){
    throw errors.badRequest('TOKENPAY_RESOURCE_INVALID','TokenPay callback resource is invalid');
  }
  let encrypted;
  try{encrypted=Buffer.from(resource.ciphertext,'base64')}catch{throw errors.badRequest('TOKENPAY_RESOURCE_INVALID','TokenPay callback ciphertext is invalid');}
  if(encrypted.length<=16) throw errors.badRequest('TOKENPAY_RESOURCE_INVALID','TokenPay callback ciphertext is invalid');
  try{
    const ciphertext=encrypted.subarray(0,-16),tag=encrypted.subarray(-16);
    const decipher=crypto.createDecipheriv('aes-256-gcm',appSecretKey(appSecret),Buffer.from(String(resource.nonce),'utf8'));
    if(resource.associated_data!==undefined&&resource.associated_data!==null) decipher.setAAD(Buffer.from(String(resource.associated_data),'utf8'));
    decipher.setAuthTag(tag);
    const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
  }catch(error){
    if(error?.code&&String(error.code).startsWith('TOKENPAY_')) throw error;
    throw errors.badRequest('TOKENPAY_RESOURCE_DECRYPT_FAILED','TokenPay callback resource could not be authenticated');
  }
}

function header(response,name){return response.headers.get(name)||response.headers.get(name.toLowerCase())||'';}

export async function createTokenPayPrepayment({credentials,config,order,attemptRef,notifyUrl,returnUrl,expireSecond,settlementAmount=null,fetchImpl=fetch}){
  const appId=String(credentials.app_id||'').trim(),mchId=String(credentials.mch_id||'').trim(),appSecret=String(credentials.app_secret||'');
  if(!appId||!mchId) throw errors.conflict('TOKENPAY_CREDENTIALS_INCOMPLETE','TokenPay App ID and Merchant ID are required');
  appSecretKey(appSecret);
  const chain=String(config.chain||'').trim().toUpperCase(),currency=String(config.currency||'').trim().toUpperCase();
  if(!chain||!currency) throw errors.conflict('TOKENPAY_CONFIG_INCOMPLETE','TokenPay chain and currency are required');
  const amount=settlementAmount??order.grand_total;
  if(!Number.isFinite(Number(amount))||Number(amount)<=0) throw errors.conflict('TOKENPAY_AMOUNT_INVALID','TokenPay settlement amount must be greater than zero');
  const payload={
    app_id:appId,mch_id:mchId,description:`Order ${order.order_number}`,out_trade_no:attemptRef,
    expire_second:expireSecond,amount:Number(amount),chain,currency,
    attach:order.public_id,locale:config.locale==='zh_cn'?'zh_cn':'en',notify_url:notifyUrl,return_url:returnUrl,order_type:'platform_order',
  };
  if(config.to_address) payload.to_address=String(config.to_address).trim();
  const body=JSON.stringify(payload),timestamp=Date.now().toString(),nonce=tokenPayNonce();
  const signature=signTokenPayRequest({path:TOKENPAY_PREPAY_PATH,timestamp,nonce,body,appSecret});
  const response=await fetchImpl(`${TOKENPAY_API_BASE}${TOKENPAY_PREPAY_PATH}`,{
    method:'POST',headers:{Authorization:buildTokenPayAuthorization({appId,mchId,timestamp,nonce,signature}),'Content-Type':'application/json','User-Agent':'Shope TokenPay Gateway/1.0'},body,
  });
  const raw=await response.text();
  if(!response.ok) throw errors.unavailable('TOKENPAY_HTTP_ERROR',`TokenPay request failed with HTTP ${response.status}`);
  let parsed;try{parsed=JSON.parse(raw)}catch{throw errors.unavailable('TOKENPAY_RESPONSE_INVALID','TokenPay returned invalid JSON');}
  const responseTimestamp=header(response,'TTPay-Timestamp'),responseNonce=header(response,'TTPay-Nonce'),responseSignature=header(response,'TTPay-Signature');
  if(responseTimestamp||responseNonce||responseSignature){
    const verification=verifyTokenPayResponse({timestamp:responseTimestamp,nonce:responseNonce,rawBody:raw,signature:responseSignature,appSecret});
    if(!verification.ok){
      const diagnostic=tokenPayResponseSignatureDiagnostic({response,timestamp:responseTimestamp,nonce:responseNonce,body:raw,signature:responseSignature,appSecret,canonicalBody:verification.canonicalBody,rawDataBody:verification.rawDataBody,dataBody:verification.dataBody});
      console.warn('TOKENPAY_RESPONSE_SIGNATURE_DIAGNOSTIC',JSON.stringify(diagnostic));
      throw errors.unavailable('TOKENPAY_RESPONSE_SIGNATURE_INVALID','TokenPay response signature verification failed');
    }
  }
  if(Number(parsed?.code)!==0||!parsed?.data?.prepay_id||!parsed?.data?.payment_url){
    throw errors.unavailable('TOKENPAY_PREPAYMENT_FAILED',String(parsed?.msg||'TokenPay did not create the payment session'));
  }
  const paymentUrl=new URL(String(parsed.data.payment_url),TOKENPAY_API_BASE).toString();
  return {prepay_id:String(parsed.data.prepay_id),payment_url:paymentUrl,request_id:String(parsed.request_id||''),expires_in:expireSecond};
}

export function tokenPayNotificationOutcome(event,resource){
  const eventType=String(event?.event_type||'').trim().toUpperCase();
  const state=String(resource?.trade_state||resource?.status||resource?.payment_status||'').trim().toUpperCase();
  const success=eventType.endsWith('.SUCCESS')||['SUCCESS','PAID','COMPLETED'].includes(state);
  const failure=eventType.endsWith('.FAILED')||eventType.endsWith('.PAYERROR')||['FAILED','PAYERROR','CLOSED','CANCELLED','EXPIRED'].includes(state);
  return success?'SUCCESS':failure?'FAILED':'UNKNOWN';
}

export function tokenPayNotificationAmount(resource){
  const value=resource?.amount;
  if(typeof value==='number'||typeof value==='string') return Number(value);
  if(value&&typeof value==='object'){
    for(const key of ['amount','total','payer_total']){if(value[key]!==undefined&&Number.isFinite(Number(value[key])))return Number(value[key]);}
  }
  return NaN;
}

export function tokenPayNotificationCurrency(resource){
  const value=resource?.currency??resource?.amount?.currency??resource?.payer_currency??resource?.amount?.payer_currency;
  return String(value||'').trim().toUpperCase();
}
