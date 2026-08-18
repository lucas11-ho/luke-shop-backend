import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const MIME_EXT = new Map([
  ['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],
  ['video/mp4','.mp4'],['video/webm','.webm'],
]);
const EMPTY_SHA256=createHash('sha256').update('').digest('hex');
const encodePath=value=>String(value).split('/').map(encodeURIComponent).join('/');
const hmac=(key,value,encoding)=>createHmac('sha256',key).update(value).digest(encoding);
const sha=value=>createHash('sha256').update(value).digest('hex');

export function mediaTypeForMime(mime) { return mime.startsWith('image/') ? 'IMAGE' : mime.startsWith('video/') ? 'VIDEO' : null; }
export function extensionForMime(mime) { return MIME_EXT.get(mime) || null; }
export function allowedMime(mime) { return MIME_EXT.has(mime); }

export function hasExpectedSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff;
  if (mime === 'image/png') return buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === 'image/gif') return ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString('ascii'));
  if (mime === 'image/webp') return buffer.subarray(0,4).toString('ascii')==='RIFF' && buffer.subarray(8,12).toString('ascii')==='WEBP';
  if (mime === 'video/mp4') return buffer.subarray(4,8).toString('ascii')==='ftyp';
  if (mime === 'video/webm') return buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return false;
}

export function safeOriginalFilename(value) {
  const base=path.basename(String(value||'upload')).replace(/[\x00-\x1f<>:"/\\|?*]+/g,'_').trim();
  return (base || 'upload').slice(0,240);
}

export function localStorageRoot(config) { return path.resolve(process.cwd(), config.assetLocalDir); }
export function localAssetPath(config, storageKey) {
  const root=localStorageRoot(config); const full=path.resolve(root, storageKey);
  if (!(full===root || full.startsWith(root+path.sep))) throw new Error('Unsafe asset storage key');
  return full;
}
export async function writeLocalAsset(config, storageKey, body) {
  const full=localAssetPath(config,storageKey); await mkdir(path.dirname(full),{recursive:true}); await writeFile(full,body,{flag:'wx'}); return full;
}
export async function statLocalAsset(config,storageKey){return stat(localAssetPath(config,storageKey));}
export async function deleteLocalAsset(config,storageKey){try{await unlink(localAssetPath(config,storageKey));return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}}
export function streamLocalAsset(config,storageKey,range){return createReadStream(localAssetPath(config,storageKey),range);}

function r2Request(config,{method='GET',storageKey,body=null,contentType='',range=''}){
  const now=new Date();const amzDate=now.toISOString().replace(/[:-]|\.\d{3}/g,'');const date=amzDate.slice(0,8);
  const host=`${config.r2AccountId}.r2.cloudflarestorage.com`;const canonicalUri=`/${encodeURIComponent(config.r2Bucket)}/${encodePath(storageKey)}`;
  const payloadHash=body?sha(body):EMPTY_SHA256;const headers={host,'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate};if(contentType)headers['content-type']=contentType;
  const signedNames=Object.keys(headers).sort();const canonicalHeaders=signedNames.map(k=>`${k}:${headers[k]}\n`).join('');const signedHeaders=signedNames.join(';');
  const canonicalRequest=[method,canonicalUri,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');const scope=`${date}/auto/s3/aws4_request`;const stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha(canonicalRequest)].join('\n');
  const kDate=hmac(Buffer.from(`AWS4${config.r2SecretAccessKey}`),date);const kRegion=hmac(kDate,'auto');const kService=hmac(kRegion,'s3');const kSigning=hmac(kService,'aws4_request');const signature=hmac(kSigning,stringToSign,'hex');
  const authorization=`AWS4-HMAC-SHA256 Credential=${config.r2AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const fetchHeaders={'x-amz-content-sha256':payloadHash,'x-amz-date':amzDate,Authorization:authorization};if(contentType)fetchHeaders['content-type']=contentType;if(range)fetchHeaders.Range=range;
  return {url:`https://${host}${canonicalUri}`,headers:fetchHeaders,method,body:body||undefined};
}
export async function writeR2Asset(config,storageKey,body,mime){const req=r2Request(config,{method:'PUT',storageKey,body,contentType:mime});const res=await fetch(req.url,{method:req.method,headers:req.headers,body:req.body});if(!res.ok)throw new Error(`R2 upload failed (${res.status})`);}
export async function deleteR2Asset(config,storageKey){const req=r2Request(config,{method:'DELETE',storageKey});const res=await fetch(req.url,{method:req.method,headers:req.headers});if(res.status===404)return false;if(!res.ok)throw new Error(`R2 delete failed (${res.status})`);return true;}
export async function fetchR2Asset(config,storageKey,{range=''}={}){const req=r2Request(config,{method:'GET',storageKey,range});const res=await fetch(req.url,{method:req.method,headers:req.headers});if(res.status===404)return null;if(!res.ok&&res.status!==206)throw new Error(`R2 read failed (${res.status})`);return {status:res.status,size:Number(res.headers.get('content-length')||0),contentRange:res.headers.get('content-range')||'',acceptRanges:res.headers.get('accept-ranges')||'bytes',contentType:res.headers.get('content-type')||'',body:res.body?Readable.fromWeb(res.body):null};}
export async function writeAsset(config,storageKey,body,mime){if(config.assetStorageDriver==='R2')return writeR2Asset(config,storageKey,body,mime);return writeLocalAsset(config,storageKey,body);}
export async function deleteAsset(config,storageKey){if(config.assetStorageDriver==='R2')return deleteR2Asset(config,storageKey);return deleteLocalAsset(config,storageKey);}
export function storagePublicUrl(config,storageKey,publicID){if(config.assetStorageDriver==='R2'&&config.r2PublicBaseUrl)return `${config.r2PublicBaseUrl}/${encodePath(storageKey)}`;return `${config.assetPublicBaseUrl}/v1/assets/public/${encodeURIComponent(publicID)}`;}
