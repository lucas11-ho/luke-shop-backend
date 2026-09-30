CREATE TABLE IF NOT EXISTS bot_pilot_event_outbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  child_bot_id bigint NOT NULL REFERENCES bot_pilot_shop_links(child_bot_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_type text NOT NULL,
  topic text NOT NULL CHECK (topic IN ('orders','payments')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_pilot_event_outbox_due
  ON bot_pilot_event_outbox(status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_bot_pilot_event_outbox_shop
  ON bot_pilot_event_outbox(child_bot_id, created_at DESC);
