-- Luke Shop Backend v0.5.0
-- Luke CS Commerce Connector & AI Tool Gateway Foundation

-- Existing credentials predate explicit usage modes; preserve them as STAFF credentials.
ALTER TABLE integration_clients
  ADD COLUMN usage_mode text NOT NULL DEFAULT 'STAFF'
  CHECK (usage_mode IN ('STAFF','AI'));

-- Tenant-controlled least-privilege data policy. General read flags apply to all
-- Luke CS clients. AI credentials additionally require the matching ai_* flag.
CREATE TABLE customer_service_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  customer_read boolean NOT NULL DEFAULT true,
  product_read boolean NOT NULL DEFAULT true,
  orders_read boolean NOT NULL DEFAULT true,
  payments_read boolean NOT NULL DEFAULT true,
  delivery_read boolean NOT NULL DEFAULT true,
  ai_customer_read boolean NOT NULL DEFAULT false,
  ai_product_read boolean NOT NULL DEFAULT false,
  ai_orders_read boolean NOT NULL DEFAULT false,
  ai_payments_read boolean NOT NULL DEFAULT false,
  ai_delivery_read boolean NOT NULL DEFAULT false,
  context_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (context_ttl_seconds BETWEEN 60 AND 900),
  tool_rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (tool_rate_limit_per_minute BETWEEN 1 AND 600),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve v0.4 behavior for tenants that already have an active Luke CS credential.
-- AI permissions remain off until a tenant explicitly enables them.
INSERT INTO customer_service_policies(tenant_id, enabled)
SELECT t.id,
       EXISTS(SELECT 1 FROM integration_clients c WHERE c.tenant_id=t.id AND c.kind='LUKE_CS' AND c.status='ACTIVE')
  FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;

-- Signed customer contexts are short lived, customer/session/store bound, and
-- revocable server-side even though the context itself is a JWT.
ALTER TABLE customer_sessions
  ADD CONSTRAINT customer_sessions_tenant_customer_session_key UNIQUE (tenant_id, customer_id, id);

CREATE TABLE customer_service_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  jti uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  customer_session_id uuid NOT NULL,
  store_id uuid NOT NULL,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  request_id text,
  request_ip inet,
  CHECK (expires_at > issued_at),
  CHECK (allowed_tools <@ ARRAY[
    'customer.get','product.search','product.get','orders.list',
    'order.get','order.status','payment.status','delivery.status'
  ]::text[]),
  UNIQUE(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id, customer_session_id) REFERENCES customer_sessions(tenant_id, customer_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_service_contexts_active_idx
  ON customer_service_contexts(tenant_id, customer_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Each service tool request requires a fresh timestamp+nonce. Only a SHA-256
-- digest of the nonce is persisted.
CREATE TABLE customer_service_request_nonces (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_client_id uuid NOT NULL,
  nonce_hash char(64) NOT NULL,
  request_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE(tenant_id, integration_client_id, nonce_hash),
  FOREIGN KEY (tenant_id, integration_client_id) REFERENCES integration_clients(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_service_request_nonces_expiry_idx ON customer_service_request_nonces(expires_at);

-- Durable structured tool audit. Results are summarized by code only; full
-- customer/order payloads are deliberately not copied into the audit table.
CREATE TABLE customer_service_tool_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_client_id uuid NOT NULL,
  context_id uuid,
  customer_id uuid,
  tool_name text NOT NULL CHECK (tool_name IN (
    'customer.get','product.search','product.get','orders.list',
    'order.get','order.status','payment.status','delivery.status'
  )),
  target_type text,
  target_ref text,
  result_code text NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  request_id text,
  request_nonce_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_client_id) REFERENCES integration_clients(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (context_id) REFERENCES customer_service_contexts(id) ON DELETE SET NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
CREATE INDEX customer_service_tool_calls_lookup_idx
  ON customer_service_tool_calls(tenant_id, integration_client_id, created_at DESC);
CREATE INDEX customer_service_tool_calls_customer_idx
  ON customer_service_tool_calls(tenant_id, customer_id, created_at DESC);
