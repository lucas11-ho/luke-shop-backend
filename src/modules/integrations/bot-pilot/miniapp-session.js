import { errors } from '../../../core/errors.js';
import { uuid } from '../../../core/identifiers.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../../core/tokens.js';
import { writeAudit } from '../../../core/audit.js';
import {
  createCustomerSession,
  findOrCreateProviderCustomer,
  publicCustomer,
} from '../../auth/customer-identity.js';
import { loadEffectiveStoreScope } from '../../merchant/store-access.js';

function telegramProfile(input = {}) {
  const id = String(input.id || '').trim();
  if (!/^[1-9]\d{4,19}$/.test(id)) {
    throw errors.badRequest(
      'BOT_PILOT_MINIAPP_IDENTITY_INVALID',
      'Verified Telegram user ID is invalid',
    );
  }

  const firstName = String(input.first_name || '').trim().slice(0, 120);
  const lastName = String(input.last_name || '').trim().slice(0, 120);
  const username = String(input.username || '').trim().replace(/^@/, '').slice(0, 120);
  const photoUrl = String(input.photo_url || '').trim().slice(0, 2000) || null;
  const languageCode = String(input.language_code || '').trim().slice(0, 32) || null;
  const displayName = [firstName, lastName].filter(Boolean).join(' ')
    || (username ? `@${username}` : '')
    || 'Telegram user';

  return {
    id,
    firstName,
    lastName,
    username: username || null,
    photoUrl,
    languageCode,
    displayName,
  };
}

async function loadMerchantIdentityById(client, tenantId, userId) {
  const user = await client.query(
    `SELECT id,public_id,email,display_name,status,store_access_mode
       FROM merchant_users
      WHERE tenant_id=$1 AND id=$2
      LIMIT 1`,
    [tenantId, userId],
  );
  if (!user.rowCount) return null;

  const roles = await client.query(
    `SELECT r.key
       FROM merchant_user_roles ur
       JOIN merchant_roles r
         ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id
      WHERE ur.tenant_id=$1 AND ur.merchant_user_id=$2`,
    [tenantId, userId],
  );
  const permissions = await client.query(
    `SELECT DISTINCT rp.permission_key
       FROM merchant_user_roles ur
       JOIN merchant_roles r
         ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id
       JOIN merchant_role_permissions rp ON rp.role_id=r.id
      WHERE ur.tenant_id=$1 AND ur.merchant_user_id=$2`,
    [tenantId, userId],
  );

  const roleKeys = roles.rows.map((row) => row.key);
  const storeScope = await loadEffectiveStoreScope(client, {
    tenantId,
    userId,
    roleKeys,
    storedMode: user.rows[0].store_access_mode,
  });

  return {
    ...user.rows[0],
    roleKeys,
    permissions: permissions.rows.map((row) => row.permission_key),
    storeScope,
  };
}

async function createMerchantSession(app, client, tenantId, user, request) {
  const sessionId = uuid();
  const refreshToken = newRefreshToken();

  await client.query(
    `INSERT INTO merchant_sessions(
       id,tenant_id,merchant_user_id,refresh_token_hash,
       expires_at,user_agent,request_ip
     )
     VALUES(
       $1,$2,$3,$4,
       now()+($5::text||' days')::interval,$6,$7
     )`,
    [
      sessionId,
      tenantId,
      user.id,
      hashRefreshToken(refreshToken),
      app.config.refreshTokenTtlDays,
      request.headers['user-agent'] || null,
      request.ip || null,
    ],
  );

  const access = await signAccessToken(app.config, {
    subject: user.id,
    tenantId,
    actorType: 'MERCHANT',
    sessionId,
    permissions: user.permissions,
    roleKeys: user.roleKeys,
  });

  return {
    access_token: access.token,
    expires_in: access.expiresIn,
    refresh_token: refreshToken,
  };
}

function linkIsActive(link) {
  return String(link.link_status || link.status || '').toUpperCase() === 'ACTIVE'
    && String(link.tenant_status || '').toUpperCase() === 'ACTIVE'
    && String(link.store_status || '').toUpperCase() === 'ACTIVE';
}

export async function createBotPilotMiniAppSession(
  app,
  request,
  link,
  actorType,
  telegramInput,
) {
  if (!linkIsActive(link)) {
    throw errors.forbidden(
      'BOT_PILOT_SHOP_NOT_ACTIVE',
      'This Bot Pilot shop is not active',
    );
  }

  const telegram = telegramProfile(telegramInput);
  const mode = String(actorType || '').trim().toUpperCase();

  if (mode === 'CUSTOMER') {
    return app.db.transaction(async (client) => {
      const customer = await findOrCreateProviderCustomer(app, client, {
        tenantId: link.tenant_id,
        provider: 'TELEGRAM',
        subject: telegram.id,
        displayName: telegram.displayName,
        avatarUrl: telegram.photoUrl,
        metadata: {
          username: telegram.username,
          language_code: telegram.languageCode,
          bot_pilot_mini_app: true,
          child_bot_id: Number(link.child_bot_id),
          shop_public_id: link.shop_public_id,
        },
        request,
      });

      if (customer.status !== 'ACTIVE') {
        throw errors.forbidden(
          'CUSTOMER_NOT_ACTIVE',
          'Customer account is not active',
        );
      }

      const tokens = await createCustomerSession(
        app,
        client,
        link.tenant_id,
        customer.id,
        request,
      );

      await client.query(
        `UPDATE customers
            SET last_login_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [link.tenant_id, customer.id],
      );

      await writeAudit(client, {
        tenantId: link.tenant_id,
        actorType: 'CUSTOMER',
        actorId: customer.id,
        action: 'customer.bot_pilot_miniapp_login',
        targetType: 'customer',
        targetId: customer.id,
        metadata: {
          telegram_user_id: telegram.id,
          child_bot_id: Number(link.child_bot_id),
          shop_public_id: link.shop_public_id,
        },
        requestIp: request.ip,
        requestId: request.id,
      });

      return {
        actor_type: 'CUSTOMER',
        shop_public_id: link.shop_public_id,
        tenant_id: link.tenant_public_id,
        tenant_slug: link.tenant_slug,
        store_id: link.store_public_id,
        store_slug: link.store_slug,
        customer: publicCustomer(customer),
        tokens,
      };
    });
  }

  if (mode === 'MERCHANT') {
    if (String(link.owner_telegram_user_id) !== telegram.id) {
      throw errors.forbidden(
        'BOT_PILOT_MERCHANT_NOT_AUTHORIZED',
        'Telegram user is not the owner of this Bot Pilot shop',
      );
    }

    return app.db.transaction(async (client) => {
      const merchant = await loadMerchantIdentityById(
        client,
        link.tenant_id,
        link.merchant_user_id,
      );
      if (!merchant) {
        throw errors.notFound(
          'BOT_PILOT_MERCHANT_NOT_FOUND',
          'Provisioned Bot Pilot merchant account was not found',
        );
      }
      if (merchant.status !== 'ACTIVE') {
        throw errors.forbidden(
          'MERCHANT_NOT_ACTIVE',
          'Merchant account is not active',
        );
      }

      const tokens = await createMerchantSession(
        app,
        client,
        link.tenant_id,
        merchant,
        request,
      );

      await client.query(
        `UPDATE merchant_users
            SET last_login_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [link.tenant_id, merchant.id],
      );

      await writeAudit(client, {
        tenantId: link.tenant_id,
        actorType: 'MERCHANT',
        actorId: merchant.id,
        action: 'merchant.bot_pilot_miniapp_login',
        targetType: 'merchant_user',
        targetId: merchant.id,
        metadata: {
          telegram_user_id: telegram.id,
          child_bot_id: Number(link.child_bot_id),
          shop_public_id: link.shop_public_id,
        },
        requestIp: request.ip,
        requestId: request.id,
      });

      return {
        actor_type: 'MERCHANT',
        shop_public_id: link.shop_public_id,
        tenant_id: link.tenant_public_id,
        tenant_slug: link.tenant_slug,
        store_id: link.store_public_id,
        store_slug: link.store_slug,
        user: {
          id: merchant.public_id,
          email: merchant.email,
          display_name: merchant.display_name,
          status: merchant.status,
          roles: merchant.roleKeys,
          permissions: merchant.permissions,
          store_scope: merchant.storeScope,
        },
        tokens,
      };
    });
  }

  throw errors.badRequest(
    'BOT_PILOT_MINIAPP_ACTOR_INVALID',
    'actor_type must be CUSTOMER or MERCHANT',
  );
}
