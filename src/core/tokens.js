import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const encoder = new TextEncoder();

export function newRefreshToken() {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function newServiceCredential(pepper) {
  const clientId = `lcs_${randomBytes(10).toString('base64url')}`;
  const secret = randomBytes(48).toString('base64url');
  return {
    clientId,
    secret,
    secretHash: hashServiceSecret(secret, pepper),
  };
}

export function hashServiceSecret(secret, pepper) {
  return createHmac('sha256', pepper).update(String(secret || '')).digest('hex');
}

export function safeHashEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function signAccessToken(config, actor) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.jwtAccessTtlMinutes * 60;
  const jwt = await new SignJWT({
    tenant_id: actor.tenantId,
    actor_type: actor.actorType,
    session_id: actor.sessionId,
    permissions: actor.permissions || [],
    role_keys: actor.roleKeys || [],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('luke-shop-backend')
    .setAudience('luke-shop-apps')
    .setSubject(actor.subject)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(config.jwtAccessSecret));
  return { token: jwt, expiresAt: new Date(exp * 1000), expiresIn: exp - now };
}

export async function verifyAccessToken(config, token) {
  const result = await jwtVerify(token, encoder.encode(config.jwtAccessSecret), {
    issuer: 'luke-shop-backend',
    audience: 'luke-shop-apps',
    algorithms: ['HS256'],
  });
  return result.payload;
}


export async function signSupportContext(config, context) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(Number(context.ttlSeconds || 300), 900));
  const exp = now + ttl;
  const jti = randomUUID();
  const jwt = await new SignJWT({
    tenant_id: context.tenantId,
    customer_public_id: context.customerPublicId,
    session_id: context.sessionId,
    store_id: context.storeId,
    store_public_id: context.storePublicId,
    customer_code: context.customerCode || null,
    page_path: context.pagePath || null,
    current_order_ref: context.currentOrderRef || null,
    locale: context.locale || null,
    allowed_tools: context.allowedTools || [],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('luke-shop-backend')
    .setAudience('luke-shop-cs-context')
    .setSubject(context.customerId)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(config.csContextSigningSecret));
  return { token: jwt, jti, expiresAt: new Date(exp * 1000), expiresIn: ttl };
}

export async function verifySupportContext(config, token) {
  const result = await jwtVerify(token, encoder.encode(config.csContextSigningSecret), {
    issuer: 'luke-shop-backend', audience: 'luke-shop-cs-context', algorithms: ['HS256'],
  });
  return { ...result.payload, jti: result.payload.jti };
}


export async function signServiceAccessToken(config, service) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(Number(config.csServiceTokenTtlSeconds || 300), 900));
  const exp = now + ttl;
  const jwt = await new SignJWT({ tenant_id: service.tenantId, usage_mode: service.usageMode })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('luke-shop-backend')
    .setAudience('luke-shop-cs-service')
    .setSubject(service.clientId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(config.csServiceSigningSecret));
  return { token: jwt, expiresIn: ttl, expiresAt: new Date(exp * 1000) };
}

export async function verifyServiceAccessToken(config, token) {
  const result = await jwtVerify(token, encoder.encode(config.csServiceSigningSecret), {
    issuer: 'luke-shop-backend', audience: 'luke-shop-cs-service', algorithms: ['HS256'],
  });
  return result.payload;
}


export async function signPlatformAccessToken(config, actor) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.jwtAccessTtlMinutes * 60;
  const jwt = await new SignJWT({ actor_type: 'PLATFORM', session_id: actor.sessionId, role: actor.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('luke-shop-backend')
    .setAudience('luke-shop-platform-admin')
    .setSubject(actor.subject)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(config.jwtAccessSecret));
  return { token: jwt, expiresAt: new Date(exp * 1000), expiresIn: exp - now };
}

export async function verifyPlatformAccessToken(config, token) {
  const result = await jwtVerify(token, encoder.encode(config.jwtAccessSecret), {
    issuer: 'luke-shop-backend', audience: 'luke-shop-platform-admin', algorithms: ['HS256'],
  });
  if (result.payload.actor_type !== 'PLATFORM') throw new Error('Platform actor required');
  return result.payload;
}
