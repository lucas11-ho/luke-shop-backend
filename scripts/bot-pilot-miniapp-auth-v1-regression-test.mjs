import fs from 'node:fs';

const routes = fs.readFileSync(
  new URL('../src/modules/integrations/bot-pilot/routes.js', import.meta.url),
  'utf8',
);
const session = fs.readFileSync(
  new URL('../src/modules/integrations/bot-pilot/miniapp-session.js', import.meta.url),
  'utf8',
);
const auth = fs.readFileSync(
  new URL('../src/modules/integrations/bot-pilot/auth.js', import.meta.url),
  'utf8',
);

const checks = [
  [
    'Mini App exchange route exists',
    routes.includes("app.post('/v1/integrations/bot-pilot/miniapp/session'"),
  ],
  [
    'Mini App exchange is protected by signed Bot Pilot integration auth',
    routes.includes("app.post('/v1/integrations/bot-pilot/miniapp/session'")
      && routes.includes('preHandler: signed'),
  ],
  [
    'request binds both child bot and public shop ID',
    routes.includes("Number(link.child_bot_id) !== childBotId")
      && routes.includes("String(link.shop_public_id) !== shopPublicId"),
  ],
  [
    'only customer and merchant actor types are accepted',
    routes.includes("enum: ['CUSTOMER', 'MERCHANT']"),
  ],
  [
    'customer Mini App session reuses canonical Telegram customer identity',
    session.includes("provider: 'TELEGRAM'")
      && session.includes('findOrCreateProviderCustomer')
      && session.includes('createCustomerSession'),
  ],
  [
    'customer Mini App identity is tagged as Bot Pilot sourced',
    session.includes('bot_pilot_mini_app: true')
      && session.includes('shop_public_id: link.shop_public_id'),
  ],
  [
    'merchant Mini App session is bound to the provisioned owner Telegram ID',
    session.includes("String(link.owner_telegram_user_id) !== telegram.id")
      && session.includes('BOT_PILOT_MERCHANT_NOT_AUTHORIZED'),
  ],
  [
    'merchant session keeps canonical RBAC claims',
    session.includes('merchant_role_permissions')
      && session.includes('loadEffectiveStoreScope')
      && session.includes('permissions: user.permissions')
      && session.includes('roleKeys: user.roleKeys'),
  ],
  [
    'inactive shop links cannot issue Mini App sessions',
    session.includes('BOT_PILOT_SHOP_NOT_ACTIVE')
      && session.includes("=== 'ACTIVE'"),
  ],
  [
    'Mini App login writes customer and merchant audit records',
    session.includes('customer.bot_pilot_miniapp_login')
      && session.includes('merchant.bot_pilot_miniapp_login'),
  ],
  [
    'integration requests are freshness and replay protected',
    auth.includes('BOT_PILOT_REQUEST_EXPIRED')
      && auth.includes('BOT_PILOT_REQUEST_REPLAYED')
      && auth.includes('timingSafeEqual'),
  ],
  [
    'Luke Shop Mini App session service does not store or accept bot tokens',
    !session.includes('bot_token')
      && !routes.includes('telegram_bot_token'),
  ],
];

let passed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (ok) passed += 1;
}
console.log(`${passed}/${checks.length} Bot Pilot Mini App auth checks passed`);
if (passed !== checks.length) process.exit(1);
