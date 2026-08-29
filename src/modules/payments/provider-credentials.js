import crypto from 'node:crypto';
import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';

function encryptionKey(app) {
  const secret = String(app.config.paymentCredentialEncryptionKey || '');
  if (secret.length < 32) {
    throw errors.unavailable('PAYMENT_CREDENTIALS_UNAVAILABLE','Payment credential encryption is not configured');
  }
  return crypto.createHash('sha256').update(secret,'utf8').digest();
}

function encryptJson(app, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(app), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptJson(app, row) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(app), Buffer.from(row.iv,'base64'));
    decipher.setAuthTag(Buffer.from(row.auth_tag,'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext,'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch (error) {
    if (error?.code === 'PAYMENT_CREDENTIALS_UNAVAILABLE') throw error;
    throw errors.unavailable('PAYMENT_CREDENTIALS_DECRYPT_FAILED','Payment provider credentials could not be decrypted');
  }
}

export async function saveProviderCredentials(app, client, { tenantId, storeId, paymentMethodId, providerKey, credentials }) {
  const encrypted = encryptJson(app, credentials);
  const row = await client.query(`INSERT INTO payment_provider_credentials(
      id,public_id,tenant_id,store_id,payment_method_id,provider_key,ciphertext,iv,auth_tag,key_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
    ON CONFLICT(tenant_id,store_id,payment_method_id) DO UPDATE SET
      provider_key=EXCLUDED.provider_key,ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,
      key_version=payment_provider_credentials.key_version+1,updated_at=now()
    RETURNING public_id,provider_key,key_version,created_at,updated_at`,[
      uuid(),publicId('pcred'),tenantId,storeId,paymentMethodId,providerKey,
      encrypted.ciphertext,encrypted.iv,encrypted.authTag,
    ]);
  return row.rows[0];
}

export async function loadProviderCredentials(app, db, { tenantId, storeId, paymentMethodId, providerKey = null }) {
  const params=[tenantId,storeId,paymentMethodId];
  let filter='tenant_id=$1 AND store_id=$2 AND payment_method_id=$3';
  if(providerKey){params.push(providerKey);filter+=` AND provider_key=$${params.length}`;}
  const result=await db.query(`SELECT * FROM payment_provider_credentials WHERE ${filter} LIMIT 1`,params);
  if(!result.rowCount) throw errors.conflict('PAYMENT_PROVIDER_NOT_CONFIGURED','Payment provider credentials are not configured');
  return decryptJson(app,result.rows[0]);
}

export async function providerCredentialStatus(db, { tenantId, storeId, paymentMethodId }) {
  const result=await db.query(`SELECT provider_key,key_version,created_at,updated_at FROM payment_provider_credentials
    WHERE tenant_id=$1 AND store_id=$2 AND payment_method_id=$3 LIMIT 1`,[tenantId,storeId,paymentMethodId]);
  if(!result.rowCount) return { configured:false };
  return { configured:true, ...result.rows[0] };
}

export function tokenPayCredentialView(credentials = {}) {
  return {
    app_id: String(credentials.app_id || ''),
    mch_id: String(credentials.mch_id || ''),
    app_secret_configured: Boolean(credentials.app_secret),
  };
}
