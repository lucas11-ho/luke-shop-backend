import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { errors } from '../../../core/errors.js';

function scalarHeader(request, name) {
  const value = request.headers[name];
  if (!value || Array.isArray(value)) return '';
  return String(value).trim();
}

function safeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function botPilotCanonicalRequest(request) {
  const timestamp = scalarHeader(request, 'x-botpilot-timestamp');
  const nonce = scalarHeader(request, 'x-botpilot-nonce');
  const rawBody = typeof request.rawBody === 'string' ? request.rawBody : '';
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const path = request.raw?.url || request.url || '/';
  return {
    timestamp,
    nonce,
    bodyHash,
    canonical: [
      String(request.method || 'GET').toUpperCase(),
      path,
      timestamp,
      nonce,
      bodyHash,
    ].join('\n'),
  };
}

export function botPilotIntegrationAuthPlugin(app) {
  app.decorateRequest('botPilotAuth', null);

  app.decorate('requireBotPilotIntegration', async function requireBotPilotIntegration(request) {
    const secret = app.config.botPilotSigningSecret;
    if (!secret) {
      throw errors.unavailable(
        'BOT_PILOT_INTEGRATION_NOT_CONFIGURED',
        'Bot Pilot integration is not configured',
      );
    }

    const signature = scalarHeader(request, 'x-botpilot-signature').toLowerCase();
    const { timestamp, nonce, canonical } = botPilotCanonicalRequest(request);

    if (!/^\d{10,13}$/.test(timestamp)) {
      throw errors.unauthorized('BOT_PILOT_SIGNATURE_INVALID', 'Invalid Bot Pilot request timestamp');
    }
    if (!/^[A-Za-z0-9_-]{16,120}$/.test(nonce)) {
      throw errors.unauthorized('BOT_PILOT_SIGNATURE_INVALID', 'Invalid Bot Pilot request nonce');
    }
    if (!/^[a-f0-9]{64}$/.test(signature)) {
      throw errors.unauthorized('BOT_PILOT_SIGNATURE_INVALID', 'Invalid Bot Pilot request signature');
    }

    let timestampSeconds = Number(timestamp);
    if (timestamp.length === 13) timestampSeconds /= 1000;
    const nowSeconds = Date.now() / 1000;
    if (
      !Number.isFinite(timestampSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > app.config.botPilotRequestMaxSkewSeconds
    ) {
      throw errors.unauthorized('BOT_PILOT_REQUEST_EXPIRED', 'Bot Pilot request timestamp is outside the allowed window');
    }

    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    if (!safeEqualHex(signature, expected)) {
      throw errors.unauthorized('BOT_PILOT_SIGNATURE_INVALID', 'Invalid Bot Pilot request signature');
    }

    // Consume the nonce only after the signature is valid. ON CONFLICT makes
    // concurrent replay attempts fail closed.
    await app.db.query('DELETE FROM bot_pilot_request_nonces WHERE expires_at <= now()');
    const consumed = await app.db.query(
      `INSERT INTO bot_pilot_request_nonces(nonce,expires_at)
       VALUES($1,now()+($2::text||' seconds')::interval)
       ON CONFLICT (nonce) DO NOTHING
       RETURNING nonce`,
      [nonce, app.config.botPilotNonceTtlSeconds],
    );
    if (!consumed.rowCount) {
      throw errors.unauthorized('BOT_PILOT_REQUEST_REPLAYED', 'Bot Pilot request nonce was already used');
    }

    request.botPilotAuth = {
      nonce,
      timestamp: timestampSeconds,
    };
  });
}
