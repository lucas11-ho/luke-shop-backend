const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(name) {
  const value = required(name);
  if (value.length < 48) throw new Error(`${name} must contain at least 48 characters`);
  if (/replace-with/i.test(value)) throw new Error(`${name} still contains the example placeholder`);
  return value;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  const production = nodeEnv === 'production';
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const config = {
    release: '0.14.2-google-maps-delivery-address-pro',
    nodeEnv,
    production,
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: intEnv('PORT', 4100, { min: 1, max: 65535 }),
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    trustProxy: boolEnv('TRUST_PROXY', production),
    databaseUrl: required('DATABASE_URL'),
    dbPoolMax: intEnv('DB_POOL_MAX', 20, { min: 2, max: 200 }),
    dbConnectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 5000, { min: 250, max: 60000 }),
    dbStatementTimeoutMs: intEnv('DB_STATEMENT_TIMEOUT_MS', 15000, { min: 500, max: 120000 }),
    jwtAccessSecret: production ? secret('JWT_ACCESS_SECRET') : required('JWT_ACCESS_SECRET'),
    jwtAccessTtlMinutes: intEnv('JWT_ACCESS_TTL_MINUTES', 15, { min: 5, max: 60 }),
    refreshTokenTtlDays: intEnv('REFRESH_TOKEN_TTL_DAYS', 30, { min: 1, max: 180 }),
    serviceCredentialPepper: production ? secret('SERVICE_CREDENTIAL_PEPPER') : required('SERVICE_CREDENTIAL_PEPPER'),
    csContextSigningSecret: process.env.CS_CONTEXT_SIGNING_SECRET?.trim()
      ? (production ? secret('CS_CONTEXT_SIGNING_SECRET') : required('CS_CONTEXT_SIGNING_SECRET'))
      : (production ? secret('CS_CONTEXT_SIGNING_SECRET') : required('JWT_ACCESS_SECRET')),
    csServiceSigningSecret: process.env.CS_SERVICE_SIGNING_SECRET?.trim()
      ? (production ? secret('CS_SERVICE_SIGNING_SECRET') : required('CS_SERVICE_SIGNING_SECRET'))
      : (production ? secret('CS_SERVICE_SIGNING_SECRET') : (process.env.CS_CONTEXT_SIGNING_SECRET?.trim() ? required('CS_CONTEXT_SIGNING_SECRET') : required('JWT_ACCESS_SECRET'))),
    csServiceTokenTtlSeconds: intEnv('CS_SERVICE_TOKEN_TTL_SECONDS', 300, { min: 60, max: 900 }),
    csRequestMaxSkewSeconds: intEnv('CS_REQUEST_MAX_SKEW_SECONDS', 120, { min: 30, max: 600 }),
    csRequestNonceTtlSeconds: intEnv('CS_REQUEST_NONCE_TTL_SECONDS', 300, { min: 60, max: 1800 }),
    corsOrigins,
    bodyLimitBytes: intEnv('BODY_LIMIT_BYTES', 1048576, { min: 65536, max: 10485760 }),
    rateLimitMax: intEnv('RATE_LIMIT_MAX', 300, { min: 10, max: 10000 }),
    authRateLimitMax: intEnv('AUTH_RATE_LIMIT_MAX', 20, { min: 3, max: 500 }),
    storefrontHostSuffix: process.env.STOREFRONT_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, '') || '',
    storefrontPreviewTtlSeconds: intEnv('STOREFRONT_PREVIEW_TTL_SECONDS', 600, { min: 60, max: 3600 }),
    assetStorageDriver: (process.env.ASSET_STORAGE_DRIVER || 'LOCAL').trim().toUpperCase(),
    r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || '',
    r2Bucket: process.env.R2_BUCKET?.trim() || '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || '',
    r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || '',
    assetLocalDir: process.env.ASSET_LOCAL_DIR?.trim() || '.data/assets',
    assetPublicBaseUrl: process.env.ASSET_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || `http://localhost:${intEnv('PORT', 4100, { min: 1, max: 65535 })}`,
    assetImageMaxBytes: intEnv('ASSET_IMAGE_MAX_BYTES', 10485760, { min: 65536, max: 52428800 }),
    assetVideoMaxBytes: intEnv('ASSET_VIDEO_MAX_BYTES', 104857600, { min: 1048576, max: 524288000 }),
    customerGoogleClientId: process.env.CUSTOMER_GOOGLE_CLIENT_ID?.trim() || '',
    customerTelegramClientId: process.env.CUSTOMER_TELEGRAM_CLIENT_ID?.trim() || '',
    customerTelegramClientSecret: process.env.CUSTOMER_TELEGRAM_CLIENT_SECRET?.trim() || '',
    customerTelegramBotUsername: process.env.CUSTOMER_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/,'') || '',
    customerTelegramBotToken: process.env.CUSTOMER_TELEGRAM_BOT_TOKEN?.trim() || '',
    customerTurnstileEnabled: boolEnv('CUSTOMER_TURNSTILE_ENABLED', false),
    customerTurnstileSiteKey: process.env.CUSTOMER_TURNSTILE_SITE_KEY?.trim() || '',
    customerTurnstileSecretKey: process.env.CUSTOMER_TURNSTILE_SECRET_KEY?.trim() || '',
    customerTurnstileHostnames: (process.env.CUSTOMER_TURNSTILE_HOSTNAMES || '').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean),
    customerTurnstileLoginRequired: boolEnv('CUSTOMER_TURNSTILE_LOGIN_REQUIRED', true),
    customerTurnstileSignupRequired: boolEnv('CUSTOMER_TURNSTILE_SIGNUP_REQUIRED', true),
    customerTurnstileSocialRequired: boolEnv('CUSTOMER_TURNSTILE_SOCIAL_REQUIRED', false),
    customerPhoneOtpWebhookUrl: process.env.CUSTOMER_PHONE_OTP_WEBHOOK_URL?.trim() || '',
    customerPhoneOtpWebhookBearer: process.env.CUSTOMER_PHONE_OTP_WEBHOOK_BEARER?.trim() || '',
    customerPhoneOtpHashSecret: process.env.CUSTOMER_PHONE_OTP_HASH_SECRET?.trim() || '',
    geocodingProvider: (process.env.GEOCODING_PROVIDER || 'NONE').trim().toUpperCase(),
    geocodingBaseUrl: process.env.GEOCODING_BASE_URL?.trim().replace(/\/$/,'') || '',
    googleGeocodingApiKey: process.env.GOOGLE_GEOCODING_API_KEY?.trim() || '',
    googleMapsBrowserApiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY?.trim() || '',
    googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID?.trim() || '',
  };

  if (production && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production');
  }
  if (!['LOCAL','R2'].includes(config.assetStorageDriver)) {
    throw new Error('ASSET_STORAGE_DRIVER must be LOCAL or R2');
  }
  if (config.assetStorageDriver === 'R2') {
    for (const [name, value] of [['R2_ACCOUNT_ID',config.r2AccountId],['R2_BUCKET',config.r2Bucket],['R2_ACCESS_KEY_ID',config.r2AccessKeyId],['R2_SECRET_ACCESS_KEY',config.r2SecretAccessKey]]) {
      if (!value) throw new Error(`${name} is required when ASSET_STORAGE_DRIVER=R2`);
    }
  }
  if (production && !process.env.ASSET_PUBLIC_BASE_URL?.trim() && !(config.assetStorageDriver === 'R2' && config.r2PublicBaseUrl)) {
    throw new Error('ASSET_PUBLIC_BASE_URL is required in production unless R2_PUBLIC_BASE_URL is configured');
  }
  if (!['NONE','NOMINATIM','GOOGLE'].includes(config.geocodingProvider)) throw new Error('GEOCODING_PROVIDER must be NONE, NOMINATIM, or GOOGLE');
  if (config.geocodingProvider==='NOMINATIM' && !config.geocodingBaseUrl) throw new Error('GEOCODING_BASE_URL is required when GEOCODING_PROVIDER=NOMINATIM');
  if (config.geocodingProvider==='GOOGLE') {
    if (!config.googleGeocodingApiKey) throw new Error('GOOGLE_GEOCODING_API_KEY is required when GEOCODING_PROVIDER=GOOGLE');
    if (!config.googleMapsBrowserApiKey) throw new Error('GOOGLE_MAPS_BROWSER_API_KEY is required when GEOCODING_PROVIDER=GOOGLE');
  }
  if (config.customerTurnstileEnabled) {
    if (!config.customerTurnstileSiteKey) throw new Error('CUSTOMER_TURNSTILE_SITE_KEY is required when CUSTOMER_TURNSTILE_ENABLED=true');
    if (!config.customerTurnstileSecretKey) throw new Error('CUSTOMER_TURNSTILE_SECRET_KEY is required when CUSTOMER_TURNSTILE_ENABLED=true');
    if (production && config.customerTurnstileHostnames.length === 0) throw new Error('CUSTOMER_TURNSTILE_HOSTNAMES is required in production when CUSTOMER_TURNSTILE_ENABLED=true');
  }
  if (config.customerTelegramClientId && !/^\d+$/.test(config.customerTelegramClientId)) throw new Error('CUSTOMER_TELEGRAM_CLIENT_ID must be the numeric Client ID issued by BotFather');
  if (config.customerPhoneOtpWebhookUrl && config.customerPhoneOtpHashSecret.length < 32) throw new Error('CUSTOMER_PHONE_OTP_HASH_SECRET must be at least 32 characters when phone OTP is configured');
  if (production && config.csContextSigningSecret === config.csServiceSigningSecret) {
    throw new Error('CS_CONTEXT_SIGNING_SECRET and CS_SERVICE_SIGNING_SECRET must be different in production');
  }

  return Object.freeze(config);
}
