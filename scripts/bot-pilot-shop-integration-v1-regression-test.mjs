import fs from 'node:fs';

const read = (path) =>
  fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const migration = read('migrations/043_bot_pilot_shop_integration_v1.sql');
const eventMigration = read('migrations/044_bot_pilot_event_outbox_v1.sql');
const events = read('src/modules/integrations/bot-pilot/events.js');
const customerOrders = read('src/modules/orders/customer-routes.js');
const merchantPayments = read('src/modules/payments/merchant-routes.js');
const paymentWebhooks = read('src/modules/payments/webhook-routes.js');
const auth = read('src/modules/integrations/bot-pilot/auth.js');
const routes = read('src/modules/integrations/bot-pilot/routes.js');
const miniAppSession = read('src/modules/integrations/bot-pilot/miniapp-session.js');
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
  ['Mini App session exchange is Bot Pilot signed', routes.includes("app.post('/v1/integrations/bot-pilot/miniapp/session'") && routes.includes('preHandler: signed')],
  ['Mini App exchange requires exact child bot and shop binding', routes.includes("Number(link.child_bot_id) !== childBotId") && routes.includes("String(link.shop_public_id) !== shopPublicId")],
  ['customer Mini App login reuses verified Telegram identity', miniAppSession.includes("provider: 'TELEGRAM'") && miniAppSession.includes('createCustomerSession(') && miniAppSession.includes('bot_pilot_mini_app: true')],
  ['merchant Mini App login is owner-only', miniAppSession.includes("String(link.owner_telegram_user_id) !== telegram.id") && miniAppSession.includes('BOT_PILOT_MERCHANT_NOT_AUTHORIZED')],
  ['merchant Mini App login reuses provisioned merchant and RBAC', miniAppSession.includes('link.merchant_user_id') && miniAppSession.includes('loadEffectiveStoreScope') && miniAppSession.includes("actorType: 'MERCHANT'")],
  ['Luke Shop never requires a child bot token for Mini App auth', !miniAppSession.includes('bot_token') && !routes.includes('telegram_bot_token')],
  ['app registers integration auth and routes', app.includes('botPilotIntegrationAuthPlugin(app)') && app.includes('app.register(botPilotIntegrationRoutes)')],
  ['event outbox migration is durable and idempotent', eventMigration.includes('CREATE TABLE IF NOT EXISTS bot_pilot_event_outbox') && eventMigration.includes('idempotency_key text NOT NULL UNIQUE') && eventMigration.includes("status IN ('PENDING','SENDING','DELIVERED','FAILED')")],
  ['event callback is signed with existing Bot Pilot secret', events.includes("createHmac('sha256'") && events.includes("'x-botpilot-signature'") && events.includes('botPilotSigningSecret')],
  ['event delivery retries and recovers stale sends', events.includes("FOR UPDATE SKIP LOCKED") && events.includes("status='SENDING'") && events.includes("interval '5 minutes'") && events.includes("next_attempt_at")],
  ['app starts and stops the outbox drain loop', app.includes('startBotPilotEventOutboxDrain(app)') && app.includes('clearInterval(botPilotEventTimer)')],
  ['order checkout enqueues Bot Pilot order events', customerOrders.includes("eventType:'ORDER_CREATED'") && customerOrders.includes("topic:'orders'")],
  ['manual payment outcomes enqueue Bot Pilot events', merchantPayments.includes("eventType:'PAYMENT_PAID'") && merchantPayments.includes("eventType:'PAYMENT_FAILED'")],
  ['TokenPay confirmation enqueues Bot Pilot payment event', paymentWebhooks.includes("eventType:'PAYMENT_PAID'") && paymentWebhooks.includes("provider:TOKENPAY_PROVIDER_KEY")],
  ['config supports Bot Pilot event callback URL', config.includes('BOT_PILOT_EVENT_URL') && config.includes('botPilotEventUrl')],
  ['verify includes Bot Pilot regression', pkg.scripts.verify.includes('test:botpilot-shop-integration')],
];

let passed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (ok) passed++;
}
console.log(`${passed}/${checks.length} Bot Pilot Shop integration checks passed`);
if (passed !== checks.length) process.exit(1);
