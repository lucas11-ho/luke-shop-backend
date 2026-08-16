-- Luke Shop v0.13.0 - Customer Identity, Auth Providers, Fulfillment Workflows & Merchant Notifications

CREATE TABLE IF NOT EXISTS tenant_customer_identity_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  id_prefix text NOT NULL DEFAULT 'CUS' CHECK (id_prefix ~ '^[A-Z]{2,6}$'),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  auth_config jsonb NOT NULL DEFAULT '{"email_password":true,"google":false,"telegram":false,"phone":false,"phone_countries":["KH","IN","MM","ID","PH","TH","VN","MY","SG"]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_customer_identity_settings(tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION luke_create_tenant_customer_identity_defaults()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_customer_identity_settings(tenant_id) VALUES(NEW.id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenants_customer_identity_defaults ON tenants;
CREATE TRIGGER tenants_customer_identity_defaults
AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION luke_create_tenant_customer_identity_defaults();

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_sequence bigint,
  ADD COLUMN IF NOT EXISTS customer_code text,
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS phone_country_code text,
  ADD COLUMN IF NOT EXISTS avatar_asset_id uuid,
  ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_avatar_asset_fk FOREIGN KEY (avatar_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

WITH ranked AS (
  SELECT c.id,c.tenant_id,row_number() OVER(PARTITION BY c.tenant_id ORDER BY c.created_at,c.id)::bigint AS seq
  FROM customers c WHERE c.customer_sequence IS NULL OR c.customer_code IS NULL
)
UPDATE customers c
SET customer_sequence=r.seq,
    customer_code=s.id_prefix || lpad(r.seq::text,7,'0')
FROM ranked r
JOIN tenant_customer_identity_settings s ON s.tenant_id=r.tenant_id
WHERE c.id=r.id;

UPDATE tenant_customer_identity_settings s
SET next_sequence=GREATEST(1,COALESCE((SELECT max(c.customer_sequence)+1 FROM customers c WHERE c.tenant_id=s.tenant_id),1)),updated_at=now();

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_customer_code_uq ON customers(tenant_id,customer_code) WHERE customer_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_phone_uq ON customers(tenant_id,phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('EMAIL_PASSWORD','GOOGLE','TELEGRAM','PHONE')),
  provider_subject text NOT NULL,
  email text,
  phone_e164 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,provider,provider_subject),
  UNIQUE(tenant_id,customer_id,provider)
);
CREATE INDEX IF NOT EXISTS customer_auth_identities_customer_idx ON customer_auth_identities(tenant_id,customer_id,created_at);

INSERT INTO customer_auth_identities(public_id,tenant_id,customer_id,provider,provider_subject,email,verified_at)
SELECT 'cid_'||encode(gen_random_bytes(12),'hex'),tenant_id,id,'EMAIL_PASSWORD',email,email,email_verified_at
FROM customers
WHERE email IS NOT NULL AND password_hash IS NOT NULL
ON CONFLICT (tenant_id,customer_id,provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_phone_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  country_code text NOT NULL,
  code_hash char(64) NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_phone_otp_active_idx ON customer_phone_otp_challenges(tenant_id,phone_e164,created_at DESC) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS merchant_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('ORDER_CREATED','ORDER_STATUS_CHANGED','PAYMENT_CHANGED','FULFILLMENT_CHANGED','LOW_STOCK','CUSTOMER_SERVICE')),
  title text NOT NULL,
  message text NOT NULL,
  order_id uuid,
  customer_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS merchant_notifications_unread_idx ON merchant_notifications(tenant_id,store_id,read_at,created_at DESC);

ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS formatted_address text;
ALTER TABLE order_addresses ADD COLUMN IF NOT EXISTS formatted_address text;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS product_type_snapshot text,
  ADD COLUMN IF NOT EXISTS fulfillment_id uuid;

UPDATE order_items oi
SET product_type_snapshot=p.product_type
FROM products p
WHERE p.id=oi.product_id AND p.tenant_id=oi.tenant_id AND p.store_id=oi.store_id
  AND oi.product_type_snapshot IS NULL;

ALTER TABLE order_items ALTER COLUMN product_type_snapshot SET NOT NULL;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_product_type_snapshot_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_product_type_snapshot_check
  CHECK (product_type_snapshot IN ('PHYSICAL','FOOD','DIGITAL','SERVICE'));

ALTER TABLE order_fulfillments ADD COLUMN IF NOT EXISTS fulfillment_type text;
UPDATE order_fulfillments f SET fulfillment_type=CASE
  WHEN o.order_type='FOOD' AND f.fulfillment_mode='PICKUP' THEN 'FOOD_PICKUP'
  WHEN o.order_type='FOOD' THEN 'FOOD_DELIVERY'
  WHEN o.order_type='DIGITAL' AND f.fulfillment_mode='DIGITAL_ACCESS' THEN 'DIGITAL_ACCESS'
  WHEN o.order_type='DIGITAL' THEN 'DIGITAL_DOWNLOAD'
  WHEN o.order_type='SERVICE' THEN 'SERVICE'
  WHEN f.fulfillment_mode='PICKUP' THEN 'PHYSICAL_PICKUP'
  WHEN f.fulfillment_mode='LOCAL_DELIVERY' THEN 'PHYSICAL_LOCAL_DELIVERY'
  WHEN f.fulfillment_mode='SHIPPING' THEN 'PHYSICAL_SHIPPING'
  ELSE 'NONE' END
FROM orders o WHERE o.id=f.order_id AND o.tenant_id=f.tenant_id AND o.store_id=f.store_id AND f.fulfillment_type IS NULL;
ALTER TABLE order_fulfillments ALTER COLUMN fulfillment_type SET NOT NULL;
ALTER TABLE order_fulfillments DROP CONSTRAINT IF EXISTS order_fulfillments_fulfillment_type_check;
ALTER TABLE order_fulfillments ADD CONSTRAINT order_fulfillments_fulfillment_type_check CHECK (fulfillment_type IN ('PHYSICAL_SHIPPING','PHYSICAL_LOCAL_DELIVERY','PHYSICAL_PICKUP','FOOD_DELIVERY','FOOD_PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','SERVICE','NONE'));

ALTER TABLE order_fulfillments DROP CONSTRAINT IF EXISTS order_fulfillments_tenant_id_store_id_order_id_fulfillment_mode_key;
CREATE UNIQUE INDEX IF NOT EXISTS order_fulfillments_group_uq
  ON order_fulfillments(tenant_id,store_id,order_id,fulfillment_type,fulfillment_mode);

DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_fulfillment_fk
    FOREIGN KEY (tenant_id,store_id,fulfillment_id)
    REFERENCES order_fulfillments(tenant_id,store_id,id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS order_items_fulfillment_idx ON order_items(tenant_id,store_id,fulfillment_id,created_at,id);

-- Existing orders had one fulfillment per mode. Attach every historical order item to
-- the matching mode group where possible. New mixed orders are grouped more precisely
-- by product type + fulfillment mode in application code.
UPDATE order_items oi
SET fulfillment_id=f.id
FROM order_fulfillments f
WHERE f.tenant_id=oi.tenant_id AND f.store_id=oi.store_id AND f.order_id=oi.order_id
  AND f.fulfillment_mode=oi.fulfillment_mode AND oi.fulfillment_id IS NULL;
ALTER TABLE order_fulfillments DROP CONSTRAINT IF EXISTS order_fulfillments_status_check;
ALTER TABLE order_fulfillments ADD CONSTRAINT order_fulfillments_status_check CHECK (status IN ('PENDING','PREPARING','PROCESSING','READY','SHIPPED','OUT_FOR_DELIVERY','PICKED_UP','AVAILABLE_FOR_DOWNLOAD','ACCESS_GRANTED','DELIVERED','COMPLETED','FAILED','CANCELLED'));
