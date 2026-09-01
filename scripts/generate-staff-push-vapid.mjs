import { generateKeyPairSync } from 'node:crypto';

const { publicKey,privateKey }=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pub=publicKey.export({format:'jwk'}),priv=privateKey.export({format:'jwk'});
const rawPublic=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')]).toString('base64url');
const rawPrivate=priv.d;
if(Buffer.from(rawPublic,'base64url').length!==65||Buffer.from(rawPrivate,'base64url').length!==32)throw new Error('Generated VAPID key material has an unexpected size');
console.log('# Store the private key only in the Backend secret environment.');
console.log(`STAFF_WEB_PUSH_VAPID_PUBLIC_KEY=${rawPublic}`);
console.log(`STAFF_WEB_PUSH_VAPID_PRIVATE_KEY=${rawPrivate}`);
console.log('STAFF_WEB_PUSH_VAPID_SUBJECT=mailto:replace-with-your-operations-contact@example.com');
