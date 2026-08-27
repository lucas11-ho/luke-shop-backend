const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function fail(message) {
  throw new Error(`Production environment rejected: ${message}`);
}

function normalizeHttpsOrigin(raw, name) {
  let url;
  try { url = new URL(raw); } catch { fail(`${name} contains an invalid URL: ${raw}`); }
  if (url.protocol !== 'https:') fail(`${name} must use HTTPS: ${raw}`);
  if (url.username || url.password) fail(`${name} must not contain URL credentials: ${raw}`);
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) fail(`${name} cannot use a local hostname: ${raw}`);
  if (url.pathname !== '/' || url.search || url.hash) fail(`${name} entries must be origins only, without paths, query strings, or fragments: ${raw}`);
  return url.origin;
}

function validateProductionEnvironment() {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') return;

  const rawOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawOrigins.length === 0) fail('CORS_ORIGINS is required.');
  if (rawOrigins.includes('*')) fail('CORS_ORIGINS cannot contain a wildcard.');

  const normalized = [...new Set(rawOrigins.map((origin) => normalizeHttpsOrigin(origin, 'CORS_ORIGINS')))];
  process.env.CORS_ORIGINS = normalized.join(',');

  const suffix = String(process.env.STOREFRONT_HOST_SUFFIX || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (suffix) {
    if (suffix.includes('://') || suffix.includes('/') || suffix.includes(':')) fail('STOREFRONT_HOST_SUFFIX must be a bare DNS hostname suffix.');
    if (LOCAL_HOSTS.has(suffix)) fail('STOREFRONT_HOST_SUFFIX cannot be local in production.');
    process.env.STOREFRONT_HOST_SUFFIX = suffix;
  }
}

validateProductionEnvironment();
