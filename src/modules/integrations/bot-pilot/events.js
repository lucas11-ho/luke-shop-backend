import { createHash, createHmac, randomBytes } from 'node:crypto';
import { publicId } from '../../../core/identifiers.js';

const retryDelayMs = (attempts) =>
  Math.min(10 * 60_000, 5_000 * (2 ** Math.min(Math.max(Number(attempts || 1) - 1, 0), 7)));

function canonicalBody(row) {
  return JSON.stringify({
    event_id: row.event_id,
    child_bot_id: Number(row.child_bot_id),
    event_type: row.event_type,
    topic: row.topic,
    payload: row.payload || {},
  });
}

function signedHeaders(config, url, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString('base64url');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = [
    'POST',
    url.pathname + url.search,
    timestamp,
    nonce,
    bodyHash,
  ].join('\n');
  const signature = createHmac('sha256', config.botPilotSigningSecret)
    .update(canonical)
    .digest('hex');
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-botpilot-timestamp': timestamp,
    'x-botpilot-nonce': nonce,
    'x-botpilot-signature': signature,
  };
}

export async function enqueueBotPilotShopEvent(client, {
  tenantId,
  storeId,
  eventType,
  topic,
  payload,
  idempotencyKey,
}) {
  const link = await client.query(
    `SELECT child_bot_id
       FROM bot_pilot_shop_links
      WHERE tenant_id=$1
        AND store_id=$2
        AND status='ACTIVE'
      LIMIT 1`,
    [tenantId, storeId],
  );
  if (!link.rowCount) return null;

  const eventId = publicId('bpevt');
  const inserted = await client.query(
    `INSERT INTO bot_pilot_event_outbox(
       event_id,idempotency_key,child_bot_id,tenant_id,store_id,
       event_type,topic,payload,status,next_attempt_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'PENDING',now())
     ON CONFLICT(idempotency_key) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      String(idempotencyKey),
      Number(link.rows[0].child_bot_id),
      tenantId,
      storeId,
      String(eventType),
      String(topic),
      JSON.stringify(payload || {}),
    ],
  );
  if (inserted.rowCount) return inserted.rows[0].event_id;

  const existing = await client.query(
    'SELECT event_id FROM bot_pilot_event_outbox WHERE idempotency_key=$1 LIMIT 1',
    [String(idempotencyKey)],
  );
  return existing.rows[0]?.event_id || null;
}

async function claimDue(app, limit) {
  return app.db.transaction(async (client) => {
    const claimed = await client.query(
      `WITH due AS (
         SELECT id
           FROM bot_pilot_event_outbox
          WHERE (
            status IN ('PENDING','FAILED')
            AND next_attempt_at <= now()
          ) OR (
            status='SENDING'
            AND last_attempt_at < now() - interval '5 minutes'
          )
          ORDER BY created_at,id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE bot_pilot_event_outbox o
          SET status='SENDING',
              attempts=o.attempts+1,
              last_attempt_at=now(),
              updated_at=now()
        WHERE o.id IN (SELECT id FROM due)
       RETURNING o.*`,
      [Math.max(1, Math.min(Number(limit || 10), 50))],
    );
    return claimed.rows;
  });
}

async function markDelivered(app, row) {
  await app.db.query(
    `UPDATE bot_pilot_event_outbox
        SET status='DELIVERED',
            delivered_at=now(),
            last_error=NULL,
            updated_at=now()
      WHERE id=$1`,
    [row.id],
  );
}

async function markFailed(app, row, error) {
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(row.attempts));
  await app.db.query(
    `UPDATE bot_pilot_event_outbox
        SET status='FAILED',
            next_attempt_at=$1,
            last_error=$2,
            updated_at=now()
      WHERE id=$3`,
    [nextAttemptAt, String(error || 'Delivery failed').slice(0, 2000), row.id],
  );
}

async function deliverOne(app, row) {
  const url = new URL(app.config.botPilotEventUrl);
  const body = canonicalBody(row);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: signedHeaders(app.config, url, body),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Bot Pilot returned HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    }
    await markDelivered(app, row);
    app.log.info({
      event_id: row.event_id,
      event_type: row.event_type,
      child_bot_id: row.child_bot_id,
    }, 'Bot Pilot Shop event delivered');
    return true;
  } catch (error) {
    await markFailed(app, row, error?.message || error);
    app.log.warn({
      err: error,
      event_id: row.event_id,
      event_type: row.event_type,
      child_bot_id: row.child_bot_id,
    }, 'Bot Pilot Shop event delivery failed');
    return false;
  }
}

let draining = false;

export async function drainBotPilotEventOutbox(app, { limit = 10 } = {}) {
  if (!app.config.botPilotEventUrl || !app.config.botPilotSigningSecret) {
    return { claimed: 0, delivered: 0, skipped: true };
  }
  if (draining) return { claimed: 0, delivered: 0, busy: true };

  draining = true;
  try {
    const rows = await claimDue(app, limit);
    let delivered = 0;
    for (const row of rows) {
      if (await deliverOne(app, row)) delivered += 1;
    }
    return { claimed: rows.length, delivered };
  } finally {
    draining = false;
  }
}

export function startBotPilotEventOutboxDrain(app) {
  if (!app.config.botPilotEventUrl || !app.config.botPilotSigningSecret) {
    return null;
  }
  void drainBotPilotEventOutbox(app, { limit: 20 }).catch((error) => {
    app.log.warn({ err: error }, 'Initial Bot Pilot Shop outbox drain failed');
  });
  const timer = setInterval(() => {
    void drainBotPilotEventOutbox(app, { limit: 20 }).catch((error) => {
      app.log.warn({ err: error }, 'Bot Pilot Shop outbox drain failed');
    });
  }, 30_000);
  timer.unref?.();
  return timer;
}
