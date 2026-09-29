import fs from 'node:fs';

const read = (path) =>
  fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const migration = read('migrations/043_bot_pilot_shop_integration_v1.sql');
const auth = read('src/modules/integrations/bot-pilot/auth.js');
const routes = read('src/modules/integrations/bot-pilot/routes.js');
const config = read('src/config.js');
const app = read('src/app.js');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['migration creates Bot Pilot shop links', migration.includes('CREATE TABLE IF NOT EXISTS bot_pilot_shop_links')],
  ['child bot and public shop IDs are unique bindings', migration.includes('child_bot_id bigint PRIMARY KEY') && migration.includes('shop_public_id text NOT NULL UNIQUE')],
  ['migration stores tenant/store/merchant references without bot tokens', migration.includes('tenant_id uuid') && migration.includes('store_id uuid') && migration.includes('merchant_user_id uuid') && !migration.includes('bot_token')],
  ['nonce replay table exists', migration.includes('bot_pilot_request_nonces')],
  ['integration audit exists', migration.includes('bot_pilot_integration_audit')],
  ['config supports optional strong signing secret', config.includes('BOT_PILOT_SIGNING_SECRET') && config.includes('at least 48 characters')],
  ['canonical request binds method path timestamp nonce and body hash', auth.includes("String(request.method || 'GET').toUpperCase()") && auth.includes('bodyHash') && auth.includes("request.raw?.url")],
  ['HMAC SHA-256 verification is constant-time', auth.includes("createHmac('sha256'") && auth.includes('timingSafeEqual')],
  ['expired requests are rejected', auth.includes('botPilotRequestMaxSkewSeconds') && auth.includes('BOT_PILOT_REQUEST_EXPIRED')],
  ['nonces are consumed atomically', auth.includes('ON CONFLICT (nonce) DO NOTHING') && auth.includes('BOT_PILOT_REQUEST_REPLAYED')],
  ['provision route is signed', routes.includes("app.post('/v1/integrations/bot-pilot/provision-shop'") && routes.includes('preHandler: signed')],
  ['provisioning reuses canonical tenant service', routes.includes('provisionTenant(')],
  ['provisioning is idempotent', routes.includes('created: false') && routes.includes('BOT_PILOT_SHOP_LINK_CONFLICT')],
  ['synthetic merchant credential is never returned', routes.includes('internalPassword') && !routes.includes('owner_password: internalPassword,\n          return')],
  ['status sync preserves data instead of deleting shop', routes.includes("app.post('/v1/integrations/bot-pilot/shops/:childBotId/status'") && routes.includes('UPDATE tenants SET status')],
  ['app registers integration auth and routes', app.includes('botPilotIntegrationAuthPlugin(app)') && app.includes('app.register(botPilotIntegrationRoutes)')],
  ['verify includes Bot Pilot regression', pkg.scripts.verify.includes('test:botpilot-shop-integration')],
];

let passed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (ok) passed++;
}
console.log(`${passed}/${checks.length} Bot Pilot Shop integration checks passed`);
if (passed !== checks.length) process.exit(1);
