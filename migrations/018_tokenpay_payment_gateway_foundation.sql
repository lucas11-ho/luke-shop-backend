-- Shope Commerce Operations & Loyalty v1 — Payment Gateway Foundation
-- TokenPay is the first EXTERNAL provider. Existing payment/order tables remain authoritative.

-- TokenPay supports assets such as USDT, so legacy ISO-only char(3) currency fields must be widened.
-- This is a type-width migration only; it performs no FX conversion and changes no stored values.
ALTER TABLE tenant_settings ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE products ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE carts ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE cart_items ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE checkout_sessions ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE orders ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE order_items ALTER COLUMN currency TYPE varchar(12) USING trim(currency);
ALTER TABLE order_payments ALTER COLUMN currency TYPE varchar(12) USING trim(currency);

CREATE TABLE payment_provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  provider_key text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, payment_method_id),
  FOREIGN KEY (tenant_id,store_id,payment_method_id) REFERENCES payment_methods(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX payment_provider_credentials_store_idx ON payment_provider_credentials(tenant_id,store_id,provider_key);

-- Provider session metadata is already stored in order_payments.metadata and payment_attempts.response_summary.
-- Immutable provider callbacks continue to use payment_events.
