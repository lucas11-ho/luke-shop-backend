import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { errors } from '../../../core/errors.js';
import {
  TOKENPAY_API_BASE,
  TOKENPAY_PREPAY_PATH,
  TOKENPAY_PROVIDER_KEY,
  buildTokenPayAuthorization,
  signTokenPayRequest,
  tokenPayEncryptSignature,
} from './tokenpay.js';

export { TOKENPAY_PROVIDER_KEY };

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

function header(response,name){return response.headers.get(name)||response.headers.get(name.toLowerCase())||'';}

export function decryptTokenPayReplySignature(signature,appSecret){
  const encoded=String(signature||'').trim();
  if(!encoded) return null;
  let ciphertext;
  try{ciphertext=Buffer.from(encoded,'base64')}catch{return null;}
  if(!ciphertext.length||ciphertext.length%16!==0) return null;
  try{
    const decipher=crypto.createDecipheriv('aes-256-ecb',appSecretKey(appSecret),null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
  }catch{return null;}
}

function secondsTimestamp(value){
  return /^\d{13}$/.test(String(value||''))?String(Math.floor(Number(value)/1000)):'';
}

function replyCandidates({rawBody,parsed,responseTimestamp,responseNonce,requestTimestamp,requestNonce}){
  const rawData=rawTopLevelObjectProperty(rawBody,'data');
  const canonicalBody=JSON.stringify(parsed);
  const dataBody=parsed&&typeof parsed==='object'&&parsed.data!==undefined?JSON.stringify(parsed.data):null;
  const bodies=[
    ['RAW_DATA',rawData],
    ['DATA',dataBody],
    ['RAW_BODY',rawBody],
    ['CANONICAL_BODY',canonicalBody],
  ].filter(([,value])=>typeof value==='string'&&value.length>0);
  const timestamps=[
    ['RESP_MS',String(responseTimestamp||'')],
    ['RESP_SEC',secondsTimestamp(responseTimestamp)],
    ['REQ_MS',String(requestTimestamp||'')],
    ['REQ_SEC',secondsTimestamp(requestTimestamp)],
  ].filter(([,value])=>value);
  const nonces=[
    ['RESP_NONCE',String(responseNonce||'')],
    ['REQ_NONCE',String(requestNonce||'')],
  ].filter(([,value])=>value);
  const orders=[
    ['TNB',[0,1,2]],['NTB',[1,0,2]],['TBN',[0,2,1]],
    ['NBT',[1,2,0]],['BTN',[2,0,1]],['BNT',[2,1,0]],
  ];
  const separators=[['LF','\n'],['CRLF','\r\n'],['NONE','']];
  const candidates=[],seen=new Set();
  const add=(mode,plaintext)=>{
    if(!plaintext||seen.has(plaintext)) return;
    seen.add(plaintext);
    candidates.push({mode,plaintext});
  };
  for(const [bodyLabel,body] of bodies){
    for(const [timestampLabel,timestamp] of timestamps){
      for(const [nonceLabel,nonce] of nonces){
        const values=[timestamp,nonce,body];
        for(const [orderLabel,indexes] of orders){
          for(const [separatorLabel,separator] of separators){
            const joined=indexes.map(index=>values[index]).join(separator);
            add(`${bodyLabel}_${timestampLabel}_${nonceLabel}_${orderLabel}_${separatorLabel}`,joined);
            if(separator) add(`${bodyLabel}_${timestampLabel}_${nonceLabel}_${orderLabel}_${separatorLabel}_TRAILING`,`${joined}${separator}`);
          }
        }
      }
    }
  }
  return {candidates,rawData,dataBody,canonicalBody};
}

function verifyDecryptedSemanticData({decrypted,parsed,responseTimestamp,responseNonce,signature,appSecret}){
  if(typeof decrypted!=='string'||!parsed||typeof parsed!=='object'||parsed.data===undefined) return false;
  const firstLf=decrypted.indexOf('\n');
  if(firstLf<0) return false;
  const secondLf=decrypted.indexOf('\n',firstLf+1);
  if(secondLf<0||decrypted.indexOf('\n',secondLf+1)!==-1) return false;
  const signedTimestamp=decrypted.slice(0,firstLf);
  const signedNonce=decrypted.slice(firstLf+1,secondLf);
  const signedDataText=decrypted.slice(secondLf+1);
  if(!safeEqual(signedTimestamp,String(responseTimestamp||''))||!safeEqual(signedNonce,String(responseNonce||''))) return false;
  let signedData;
  try{signedData=JSON.parse(signedDataText)}catch{return false;}
  if(!isDeepStrictEqual(signedData,parsed.data)) return false;
  const reEncrypted=tokenPayEncryptSignature(decrypted,appSecret);
  return safeEqual(reEncrypted,signature);
}

export function verifyTokenPayReplySignature({rawBody,signature,appSecret,responseTimestamp,responseNonce,requestTimestamp,requestNonce}){
  if(!responseTimestamp||!responseNonce||!signature||typeof rawBody!=='string') return {ok:false,mode:null,decrypted:null,candidates:[],rawData:null,dataBody:null,canonicalBody:null,semanticDataMatch:false};
  let parsed;
  try{parsed=JSON.parse(rawBody)}catch{return {ok:false,mode:null,decrypted:null,candidates:[],rawData:null,dataBody:null,canonicalBody:null,semanticDataMatch:false};}
  const decrypted=decryptTokenPayReplySignature(signature,appSecret);
  const {candidates,rawData,dataBody,canonicalBody}=replyCandidates({rawBody,parsed,responseTimestamp,responseNonce,requestTimestamp,requestNonce});
  if(typeof decrypted==='string'){
    for(const candidate of candidates){
      if(!safeEqual(decrypted,candidate.plaintext)) continue;
      const reEncrypted=tokenPayEncryptSignature(candidate.plaintext,appSecret);
      if(safeEqual(reEncrypted,signature)) return {ok:true,mode:`DECRYPT_${candidate.mode}`,decrypted,candidates,rawData,dataBody,canonicalBody,semanticDataMatch:false};
    }
    const semanticDataMatch=verifyDecryptedSemanticData({decrypted,parsed,responseTimestamp,responseNonce,signature,appSecret});
    if(semanticDataMatch) return {ok:true,mode:'DECRYPT_RESPONSE_TNB_SEMANTIC_DATA',decrypted,candidates,rawData,dataBody,canonicalBody,semanticDataMatch:true};
  }
  return {ok:false,mode:null,decrypted,candidates,rawData,dataBody,canonicalBody,semanticDataMatch:false};
}

export function tokenPayReplySignatureDiagnostic({response,rawBody,signature,verification,responseTimestamp,responseNonce,requestTimestamp,requestNonce}){
  const decrypted=verification?.decrypted;
  const includes=value=>typeof decrypted==='string'&&typeof value==='string'&&value.length>0&&decrypted.includes(value);
  let threeLine=false,firstLineMatches=false,secondLineMatches=false,thirdLineJson=false,thirdLineSemanticData=false;
  if(typeof decrypted==='string'){
    const parts=decrypted.split('\n');
    threeLine=parts.length===3;
    if(threeLine){
      firstLineMatches=safeEqual(parts[0],String(responseTimestamp||''));
      secondLineMatches=safeEqual(parts[1],String(responseNonce||''));
      try{
        const third=JSON.parse(parts[2]);
        thirdLineJson=true;
        let parsed;
        try{parsed=JSON.parse(rawBody)}catch{}
        thirdLineSemanticData=Boolean(parsed&&typeof parsed==='object'&&isDeepStrictEqual(third,parsed.data));
      }catch{}
    }
  }
  return {
    status:Number(response?.status||0),
    signature_length:String(signature||'').length,
    decrypted:typeof decrypted==='string',
    decrypted_bytes:typeof decrypted==='string'?Buffer.byteLength(decrypted,'utf8'):0,
    decrypted_sha256:typeof decrypted==='string'?sha256(decrypted):'',
    decrypted_lf_count:typeof decrypted==='string'?(decrypted.match(/\n/g)||[]).length:0,
    decrypted_crlf_count:typeof decrypted==='string'?(decrypted.match(/\r\n/g)||[]).length:0,
    contains_response_timestamp:includes(String(responseTimestamp||'')),
    contains_response_nonce:includes(String(responseNonce||'')),
    contains_request_timestamp:includes(String(requestTimestamp||'')),
    contains_request_nonce:includes(String(requestNonce||'')),
    contains_raw_data:includes(verification?.rawData),
    contains_data:includes(verification?.dataBody),
    contains_raw_body:includes(rawBody),
    contains_canonical_body:includes(verification?.canonicalBody),
    decrypted_three_line:threeLine,
    decrypted_first_line_matches_response_timestamp:firstLineMatches,
    decrypted_second_line_matches_response_nonce:secondLineMatches,
    decrypted_third_line_json:thirdLineJson,
    decrypted_third_line_semantic_data:thirdLineSemanticData,
    semantic_data_match:Boolean(verification?.semanticDataMatch),
    candidate_count:Array.isArray(verification?.candidates)?verification.candidates.length:0,
    response_header_names:[...new Set(Array.from(response?.headers?.keys?.()||[],name=>String(name).toLowerCase()))].sort(),
  };
}

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
  const body=JSON.stringify(payload),timestamp=Date.now().toString(),nonce=crypto.randomBytes(16).toString('hex');
  const requestSignature=signTokenPayRequest({path:TOKENPAY_PREPAY_PATH,timestamp,nonce,body,appSecret});
  const response=await fetchImpl(`${TOKENPAY_API_BASE}${TOKENPAY_PREPAY_PATH}`,{
    method:'POST',
    headers:{
      Authorization:buildTokenPayAuthorization({appId,mchId,timestamp,nonce,signature:requestSignature}),
      'Content-Type':'application/json',
      'User-Agent':'Shope TokenPay Gateway/1.0',
    },
    body,
  });
  const raw=await response.text();
  if(!response.ok) throw errors.unavailable('TOKENPAY_HTTP_ERROR',`TokenPay request failed with HTTP ${response.status}`);
  let parsed;try{parsed=JSON.parse(raw)}catch{throw errors.unavailable('TOKENPAY_RESPONSE_INVALID','TokenPay returned invalid JSON');}
  const responseTimestamp=header(response,'TTPay-Timestamp'),responseNonce=header(response,'TTPay-Nonce'),responseSignature=header(response,'TTPay-Signature');
  if(responseTimestamp||responseNonce||responseSignature){
    const verification=verifyTokenPayReplySignature({rawBody:raw,signature:responseSignature,appSecret,responseTimestamp,responseNonce,requestTimestamp:timestamp,requestNonce:nonce});
    if(!verification.ok){
      console.warn('TOKENPAY_RESPONSE_SIGNATURE_DECRYPT_DIAGNOSTIC',JSON.stringify(tokenPayReplySignatureDiagnostic({response,rawBody:raw,signature:responseSignature,verification,responseTimestamp,responseNonce,requestTimestamp:timestamp,requestNonce:nonce})));
      throw errors.unavailable('TOKENPAY_RESPONSE_SIGNATURE_INVALID','TokenPay response signature verification failed');
    }
    console.info('TOKENPAY_RESPONSE_SIGNATURE_COMPAT',verification.mode);
  }
  if(Number(parsed?.code)!==0||!parsed?.data?.prepay_id||!parsed?.data?.payment_url){
    throw errors.unavailable('TOKENPAY_PREPAYMENT_FAILED',String(parsed?.msg||'TokenPay did not create the payment session'));
  }
  const paymentUrl=new URL(String(parsed.data.payment_url),TOKENPAY_API_BASE).toString();
  return {prepay_id:String(parsed.data.prepay_id),payment_url:paymentUrl,request_id:String(parsed.request_id||''),expires_in:expireSecond};
}
