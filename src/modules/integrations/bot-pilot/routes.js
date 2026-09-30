import { randomBytes } from 'node:crypto';
import { errors } from '../../../core/errors.js';
import { provisionTenant } from '../../platform/provisioning.js';
import { createBotPilotMiniAppSession } from './miniapp-session.js';

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw errors.badRequest('BOT_PILOT_INPUT_INVALID', `${field} must be a positive integer`);
  }
  return number;
}

function telegramUserId(value) {
  const text = String(value || '').trim();
  if (!/^[1-9]\d{4,19}$/.test(text)) {
    throw errors.badRequest('BOT_PILOT_INPUT_INVALID', 'owner_telegram_user_id is invalid');
  }
  return text;
}

function externalShop(row) {
  return {
    child_bot_id: Number(row.child_bot_id),
    shop_public_id: row.shop_public_id,
    status: row.link_status || row.status || 'ACTIVE',
    tenant: {
      id: row.tenant_public_id,
      slug: row.tenant_slug,
      name: row.tenant_name,
      status: row.tenant_status,
    },
    store: {
      id: row.store_public_id,
      slug: row.store_slug,
      name: row.store_name,
      status: row.store_status,
    },
    merchant: {
      id: row.merchant_public_id,
      telegram_user_id: String(row.owner_telegram_user_id),
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function linkedShop(db, childBotId, shopPublicId = null) {
  const values = [childBotId];
  let where = 'l.child_bot_id=$1';
  if (shopPublicId) {
    values.push(shopPublicId);
    where = '(l.child_bot_id=$1 OR l.shop_public_id=$2)';
  }
  const result = await db.query(
    `SELECT l.*,l.status AS link_status,
            t.public_id AS tenant_public_id,t.slug AS tenant_slug,t.name AS tenant_name,t.status AS tenant_status,
            s.public_id AS store_public_id,s.slug AS store_slug,s.name AS store_name,s.status AS store_status,
            u.public_id AS merchant_public_id
       FROM bot_pilot_shop_links l
       JOIN tenants t ON t.id=l.tenant_id
       JOIN stores s ON s.id=l.store_id AND s.tenant_id=l.tenant_id
       JOIN merchant_users u ON u.id=l.merchant_user_id AND u.tenant_id=l.tenant_id
      WHERE ${where}
      LIMIT 1`,
    values,
  );
  return result.rows[0] || null;
}

async function audit(client, request, { action, childBotId, shopPublicId, tenantId = null, metadata = {} }) {
  await client.query(
    `INSERT INTO bot_pilot_integration_audit(
       action,child_bot_id,shop_public_id,tenant_id,metadata,request_id,request_ip
     ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [
      action,
      childBotId,
      shopPublicId,
      tenantId,
      JSON.stringify(metadata || {}),
      request.id,
      request.ip || null,
    ],
  );
}

export async function botPilotIntegrationRoutes(app) {
  const signed = [app.requireBotPilotIntegration];

  app.get('/v1/integrations/bot-pilot/shops/:childBotId', {
    preHandler: signed,
  }, async (request) => {
    const childBotId = positiveInteger(request.params.childBotId, 'child_bot_id');
    const row = await linkedShop(app.db, childBotId);
    if (!row) {
      throw errors.notFound('BOT_PILOT_SHOP_NOT_FOUND', 'Bot Pilot shop is not provisioned');
    }
    return { data: { shop: externalShop(row) } };
  });

  app.post('/v1/integrations/bot-pilot/provision-shop', {
    preHandler: signed,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: [
          'child_bot_id',
          'shop_public_id',
          'tenant_slug',
          'shop_name',
          'owner_telegram_user_id',
        ],
        properties: {
          child_bot_id: { type: 'integer', minimum: 1 },
          shop_public_id: { type: 'string', minLength: 8, maxLength: 120, pattern: '^bp_[A-Za-z0-9_-]+$' },
          tenant_slug: { type: 'string', minLength: 1, maxLength: 63 },
          shop_name: { type: 'string', minLength: 1, maxLength: 160 },
          owner_telegram_user_id: { type: 'string', minLength: 5, maxLength: 20, pattern: '^[0-9]+$' },
          owner_name: { type: 'string', maxLength: 120 },
          currency: { type: 'string', minLength: 3, maxLength: 3, pattern: '^[A-Za-z]{3}$' },
          locale: { type: 'string', minLength: 2, maxLength: 20 },
          timezone: { type: 'string', minLength: 1, maxLength: 64 },
          template_key: { type: 'string', minLength: 2, maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body || {};
    const childBotId = positiveInteger(body.child_bot_id, 'child_bot_id');
    const shopPublicId = String(body.shop_public_id).trim();
    const ownerTelegramUserId = telegramUserId(body.owner_telegram_user_id);

    const existing = await linkedShop(app.db, childBotId, shopPublicId);
    if (existing) {
      if (
        Number(existing.child_bot_id) !== childBotId
        || existing.shop_public_id !== shopPublicId
      ) {
        throw errors.conflict(
          'BOT_PILOT_SHOP_LINK_CONFLICT',
          'Child bot or Shop public ID is already linked to another shop',
        );
      }
      return { data: { created: false, shop: externalShop(existing) } };
    }

    const result = await app.db.transaction(async (client) => {
      // A tenant slug that already exists outside this integration must never
      // be silently claimed by Bot Pilot.
      const slugCollision = await client.query(
        'SELECT 1 FROM tenants WHERE slug=$1',
        [String(body.tenant_slug).trim().toLowerCase()],
      );
      if (slugCollision.rowCount) {
        throw errors.conflict(
          'BOT_PILOT_TENANT_SLUG_CONFLICT',
          'Requested shop tenant slug is already in use',
        );
      }

      const internalEmail = `botpilot-${childBotId}@internal.invalid`;
      // This credential is never returned or used by Bot Pilot. Merchant Mini
      // App SSO will bind the verified Telegram identity in the next auth step.
      const internalPassword =
        randomBytes(32).toString('base64url') + 'aA1!';

      const created = await provisionTenant(
        client,
        {
          slug: String(body.tenant_slug).trim().toLowerCase(),
          name: String(body.shop_name).trim(),
          owner_email: internalEmail,
          owner_password: internalPassword,
          owner_name: String(body.owner_name || 'Bot Pilot Owner').trim() || 'Bot Pilot Owner',
          plan_key: 'STARTER',
          template_key: String(body.template_key || 'MODERN_COMMERCE').trim().toUpperCase(),
          currency: String(body.currency || 'USD').trim().toUpperCase(),
          locale: String(body.locale || 'en').trim(),
          timezone: String(body.timezone || 'UTC').trim(),
          notes: `Provisioned by Bot Pilot child bot #${childBotId}`,
        },
        { platformUserId: null },
      );

      const store = await client.query(
        'SELECT id,public_id,slug,name,status FROM stores WHERE tenant_id=$1 AND id=$2',
        [created.tenant.id, created.store_id],
      );
      const merchant = await client.query(
        'SELECT id,public_id FROM merchant_users WHERE tenant_id=$1 AND email=$2 LIMIT 1',
        [created.tenant.id, internalEmail],
      );
      if (!store.rowCount || !merchant.rowCount) {
        throw errors.conflict(
          'BOT_PILOT_PROVISION_INCOMPLETE',
          'Provisioned tenant is missing its primary store or owner',
        );
      }

      await client.query(
        `INSERT INTO bot_pilot_shop_links(
           child_bot_id,shop_public_id,tenant_id,store_id,merchant_user_id,
           owner_telegram_user_id,status
         ) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')`,
        [
          childBotId,
          shopPublicId,
          created.tenant.id,
          store.rows[0].id,
          merchant.rows[0].id,
          ownerTelegramUserId,
        ],
      );

      await audit(client, request, {
        action: 'shop.provision',
        childBotId,
        shopPublicId,
        tenantId: created.tenant.id,
        metadata: {
          tenant_slug: created.tenant.slug,
          plan_key: created.plan_key,
          template_key: created.template_key,
        },
      });

      return {
        tenantPublicId: created.tenant.public_id,
      };
    });

    const linked = await linkedShop(app.db, childBotId, shopPublicId);
    if (!linked) {
      throw errors.conflict(
        'BOT_PILOT_PROVISION_INCOMPLETE',
        'Shop link could not be resolved after provisioning',
      );
    }
    return reply.code(201).send({
      data: {
        created: true,
        shop: externalShop(linked),
        tenant_id: result.tenantPublicId,
      },
    });
  });

  app.post('/v1/integrations/bot-pilot/miniapp/session', {
    preHandler: signed,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: [
          'child_bot_id',
          'shop_public_id',
          'actor_type',
          'telegram_user',
        ],
        properties: {
          child_bot_id: { type: 'integer', minimum: 1 },
          shop_public_id: {
            type: 'string',
            minLength: 8,
            maxLength: 120,
            pattern: '^bp_[A-Za-z0-9_-]+$',
          },
          actor_type: {
            type: 'string',
            enum: ['CUSTOMER', 'MERCHANT'],
          },
          telegram_user: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: {
                type: 'string',
                minLength: 5,
                maxLength: 20,
                pattern: '^[1-9][0-9]+$',
              },
              first_name: { type: 'string', maxLength: 120 },
              last_name: { type: 'string', maxLength: 120 },
              username: { type: 'string', maxLength: 120 },
              photo_url: { type: 'string', maxLength: 2000 },
              language_code: { type: 'string', maxLength: 32 },
            },
          },
        },
      },
    },
  }, async (request) => {
    const body = request.body || {};
    const childBotId = positiveInteger(body.child_bot_id, 'child_bot_id');
    const shopPublicId = String(body.shop_public_id || '').trim();

    const link = await linkedShop(app.db, childBotId, shopPublicId);
    if (
      !link
      || Number(link.child_bot_id) !== childBotId
      || String(link.shop_public_id) !== shopPublicId
    ) {
      throw errors.notFound(
        'BOT_PILOT_SHOP_NOT_FOUND',
        'Bot Pilot shop binding was not found',
      );
    }

    const session = await createBotPilotMiniAppSession(
      app,
      request,
      link,
      body.actor_type,
      body.telegram_user,
    );

    return { data: { session } };
  });

  app.post('/v1/integrations/bot-pilot/shops/:childBotId/status', {
    preHandler: signed,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] },
          reason: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request) => {
    const childBotId = positiveInteger(request.params.childBotId, 'child_bot_id');
    const current = await linkedShop(app.db, childBotId);
    if (!current) {
      throw errors.notFound('BOT_PILOT_SHOP_NOT_FOUND', 'Bot Pilot shop is not provisioned');
    }
    const status = request.body.status;

    await app.db.transaction(async (client) => {
      await client.query(
        'UPDATE bot_pilot_shop_links SET status=$1,updated_at=now() WHERE child_bot_id=$2',
        [status, childBotId],
      );
      await client.query(
        'UPDATE tenants SET status=$1,updated_at=now() WHERE id=$2',
        [status, current.tenant_id],
      );
      await audit(client, request, {
        action: 'shop.status.sync',
        childBotId,
        shopPublicId: current.shop_public_id,
        tenantId: current.tenant_id,
        metadata: { status, reason: request.body.reason || null },
      });
    });

    return { data: { shop: externalShop(await linkedShop(app.db, childBotId)) } };
  });
}
