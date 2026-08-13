import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIME_EXT = new Map([
  ['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],
  ['video/mp4','.mp4'],['video/webm','.webm'],
]);

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
export function streamLocalAsset(config,storageKey,range){return createReadStream(localAssetPath(config,storageKey),range);}
