-- Luke Shop Backend v0.4.0 — Payments, Delivery & Promotions Foundation
-- Depends on migrations 001-003. This migration is additive; older migrations remain immutable.

INSERT INTO merchant_permissions(key, description) VALUES
('payments.read','Read payment methods, payments, attempts, and payment status'),
('payments.manage','Manage payment methods and payment confirmation/failure lifecycle'),
('delivery.read','Read delivery methods, fulfillments, tracking, and delivery status'),
('delivery.manage','Manage delivery methods, fulfillment assignment, tracking, and delivery status'),
('promotions.read','Read promotions, codes, targets, and redemptions'),
('promotions.write','Create and manage promotions, codes, and targeting rules')
ON CONFLICT (key) DO NOTHING;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
  FROM merchant_roles r
  JOIN merchant_permissions p ON p.key IN (
    'payments.read','payments.manage','delivery.read','delivery.manage','promotions.read','promotions.write'
  )
 WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('MANUAL','BANK_TRANSFER','CASH_ON_DELIVERY','EXTERNAL')),
  provider_key text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  instructions text,
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,code),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX payment_methods_store_status_idx ON payment_methods(tenant_id,store_id,status,sort_order,created_at);

CREATE TABLE order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_method_id uuid,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')),
  amount numeric(18,4) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  provider_reference text,
  customer_reference text,
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  refunded_amount numeric(18,4) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,order_id),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,payment_method_id) REFERENCES payment_methods(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX order_payments_store_status_idx ON order_payments(tenant_id,store_id,status,created_at DESC);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('CREATED','PROCESSING','SUCCEEDED','FAILED','CANCELLED')),
  provider_reference text,
  idempotency_key text,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,store_id,payment_id,attempt_no),
  UNIQUE(tenant_id,store_id,payment_id,idempotency_key),
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES order_payments(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX payment_attempts_payment_idx ON payment_attempts(tenant_id,store_id,payment_id,attempt_no DESC);

CREATE TABLE payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  payment_id uuid,
  provider_key text,
  provider_event_id text,
  event_type text NOT NULL,
  payload_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL CHECK (outcome IN ('RECEIVED','APPLIED','IGNORED','REJECTED')),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,provider_key,provider_event_id),
  FOREIGN KEY (tenant_id,store_id,payment_id) REFERENCES order_payments(tenant_id,store_id,id) ON DELETE RESTRICT
);

CREATE TABLE delivery_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  flat_fee numeric(18,4) NOT NULL DEFAULT 0 CHECK (flat_fee >= 0),
  free_over numeric(18,4) CHECK (free_over IS NULL OR free_over >= 0),
  min_order numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  estimated_min_minutes integer CHECK (estimated_min_minutes IS NULL OR estimated_min_minutes >= 0),
  estimated_max_minutes integer CHECK (estimated_max_minutes IS NULL OR estimated_max_minutes >= 0),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,code),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX delivery_methods_store_status_idx ON delivery_methods(tenant_id,store_id,status,fulfillment_mode,sort_order);

CREATE TABLE order_fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  delivery_method_id uuid,
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PREPARING','READY','SHIPPED','OUT_FOR_DELIVERY','PICKED_UP','DELIVERED','COMPLETED','FAILED','CANCELLED')),
  fee numeric(18,4) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  carrier text,
  tracking_number text,
  tracking_url text,
  external_reference text,
  estimated_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,order_id,fulfillment_mode),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,delivery_method_id) REFERENCES delivery_methods(tenant_id,store_id,id) ON DELETE RESTRICT
);
CREATE INDEX order_fulfillments_status_idx ON order_fulfillments(tenant_id,store_id,status,created_at DESC);

CREATE TABLE fulfillment_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM','LUKE_CS')),
  actor_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,fulfillment_id) REFERENCES order_fulfillments(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX fulfillment_history_idx ON fulfillment_status_history(tenant_id,store_id,fulfillment_id,created_at,id);

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  name text NOT NULL,
  promotion_type text NOT NULL CHECK (promotion_type IN ('PERCENTAGE','FIXED_AMOUNT','FREE_DELIVERY','BOGO')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXPIRED','ARCHIVED')),
  automatic boolean NOT NULL DEFAULT false,
  value numeric(18,4) NOT NULL DEFAULT 0 CHECK (value >= 0),
  buy_quantity integer CHECK (buy_quantity IS NULL OR buy_quantity > 0),
  get_quantity integer CHECK (get_quantity IS NULL OR get_quantity > 0),
  min_subtotal numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
  max_discount numeric(18,4) CHECK (max_discount IS NULL OR max_discount >= 0),
  first_order_only boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_customer_limit integer CHECK (per_customer_limit IS NULL OR per_customer_limit > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (promotion_type <> 'BOGO' OR (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX promotions_active_idx ON promotions(tenant_id,store_id,status,starts_at,ends_at);

CREATE TABLE promotion_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,code),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,promotion_id,id),
  FOREIGN KEY (tenant_id,store_id,promotion_id) REFERENCES promotions(tenant_id,store_id,id) ON DELETE CASCADE
);

CREATE TABLE promotion_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('ORDER','PRODUCT','CATEGORY')),
  product_id uuid,
  category_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type='ORDER' AND product_id IS NULL AND category_id IS NULL)
      OR (target_type='PRODUCT' AND product_id IS NOT NULL AND category_id IS NULL)
      OR (target_type='CATEGORY' AND category_id IS NOT NULL AND product_id IS NULL)),
  FOREIGN KEY (tenant_id,store_id,promotion_id) REFERENCES promotions(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,product_id) REFERENCES products(tenant_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,category_id) REFERENCES categories(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX promotion_targets_promotion_idx ON promotion_targets(tenant_id,store_id,promotion_id);

CREATE TABLE promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  promotion_code_id uuid,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  discount_amount numeric(18,4) NOT NULL CHECK (discount_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,promotion_id,order_id),
  FOREIGN KEY (tenant_id,store_id,promotion_id) REFERENCES promotions(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,promotion_code_id) REFERENCES promotion_codes(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX promotion_redemptions_customer_idx ON promotion_redemptions(tenant_id,customer_id,created_at DESC);

CREATE TABLE order_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('PROMOTION','DELIVERY','TAX','MANUAL')),
  source_id uuid,
  code text,
  description text NOT NULL,
  amount numeric(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX order_adjustments_order_idx ON order_adjustments(tenant_id,store_id,order_id,created_at,id);

-- Backfill safe, inactive/manual foundations for existing stores without changing checkout behavior.
INSERT INTO payment_methods(id,public_id,tenant_id,store_id,code,name,provider_type,status,instructions,sort_order)
SELECT gen_random_uuid(),'paym_' || replace(gen_random_uuid()::text,'-',''),s.tenant_id,s.id,'MANUAL','Manual Payment','MANUAL','ACTIVE','Merchant confirms payment manually.',0
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.tenant_id=s.tenant_id AND pm.store_id=s.id AND pm.code='MANUAL');

INSERT INTO delivery_methods(id,public_id,tenant_id,store_id,code,name,fulfillment_mode,status,flat_fee,min_order,sort_order)
SELECT gen_random_uuid(),'dlv_' || replace(gen_random_uuid()::text,'-',''),s.tenant_id,s.id,'PICKUP','Store Pickup','PICKUP','ACTIVE',0,0,0
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM delivery_methods dm WHERE dm.tenant_id=s.tenant_id AND dm.store_id=s.id AND dm.code='PICKUP');

INSERT INTO delivery_methods(id,public_id,tenant_id,store_id,code,name,fulfillment_mode,status,flat_fee,min_order,sort_order)
SELECT gen_random_uuid(),'dlv_' || replace(gen_random_uuid()::text,'-',''),s.tenant_id,s.id,'SHIPPING','Standard Shipping','SHIPPING','ACTIVE',0,0,10
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM delivery_methods dm WHERE dm.tenant_id=s.tenant_id AND dm.store_id=s.id AND dm.code='SHIPPING');

INSERT INTO delivery_methods(id,public_id,tenant_id,store_id,code,name,fulfillment_mode,status,flat_fee,min_order,sort_order)
SELECT gen_random_uuid(),'dlv_' || replace(gen_random_uuid()::text,'-',''),s.tenant_id,s.id,'LOCAL','Local Delivery','LOCAL_DELIVERY','ACTIVE',0,0,20
FROM stores s
WHERE NOT EXISTS (SELECT 1 FROM delivery_methods dm WHERE dm.tenant_id=s.tenant_id AND dm.store_id=s.id AND dm.code='LOCAL');

-- Normalize existing v0.3.0 orders into the new payment/fulfillment model.
INSERT INTO order_payments(id,public_id,tenant_id,store_id,order_id,payment_method_id,status,amount,currency,paid_at,failed_at,cancelled_at)
SELECT gen_random_uuid(),'pay_' || replace(gen_random_uuid()::text,'-',''),o.tenant_id,o.store_id,o.id,pm.id,
       CASE o.payment_status WHEN 'PAID' THEN 'PAID' WHEN 'FAILED' THEN 'FAILED' WHEN 'REFUND_PENDING' THEN 'REFUND_PENDING' WHEN 'REFUNDED' THEN 'REFUNDED' ELSE CASE WHEN o.status='CANCELLED' THEN 'CANCELLED' ELSE 'PENDING' END END,
       o.grand_total,o.currency,o.paid_at,CASE WHEN o.payment_status='FAILED' THEN o.updated_at ELSE NULL END,o.cancelled_at
  FROM orders o
  JOIN payment_methods pm ON pm.tenant_id=o.tenant_id AND pm.store_id=o.store_id AND pm.code='MANUAL'
 WHERE NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.tenant_id=o.tenant_id AND op.store_id=o.store_id AND op.order_id=o.id);

INSERT INTO payment_attempts(id,public_id,tenant_id,store_id,payment_id,attempt_no,status,request_summary,completed_at)
SELECT gen_random_uuid(),'pat_' || replace(gen_random_uuid()::text,'-',''),op.tenant_id,op.store_id,op.id,1,
       CASE op.status WHEN 'PAID' THEN 'SUCCEEDED' WHEN 'FAILED' THEN 'FAILED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'CREATED' END,
       '{"source":"v0.4.0_backfill"}'::jsonb,
       CASE WHEN op.status IN ('PAID','FAILED','CANCELLED') THEN op.updated_at ELSE NULL END
  FROM order_payments op
 WHERE NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.tenant_id=op.tenant_id AND pa.store_id=op.store_id AND pa.payment_id=op.id);

INSERT INTO order_fulfillments(id,public_id,tenant_id,store_id,order_id,delivery_method_id,fulfillment_mode,status,fee)
SELECT gen_random_uuid(),'ful_' || replace(gen_random_uuid()::text,'-',''),o.tenant_id,o.store_id,o.id,
       (SELECT dm.id FROM delivery_methods dm WHERE dm.tenant_id=o.tenant_id AND dm.store_id=o.store_id AND dm.fulfillment_mode=oi.fulfillment_mode AND dm.status='ACTIVE' ORDER BY dm.sort_order,dm.created_at LIMIT 1),
       oi.fulfillment_mode,
       CASE
         WHEN o.status IN ('CANCELLED','REFUNDED') THEN 'CANCELLED'
         WHEN o.status IN ('DELIVERED','COMPLETED') THEN 'DELIVERED'
         WHEN o.status='OUT_FOR_DELIVERY' THEN 'OUT_FOR_DELIVERY'
         WHEN o.status='SHIPPED' THEN 'SHIPPED'
         WHEN o.status IN ('READY','PACKED') THEN 'READY'
         WHEN o.status IN ('PROCESSING','PREPARING','RESTAURANT_ACCEPTED','CONFIRMED','PAID') THEN 'PREPARING'
         ELSE 'PENDING'
       END,
       CASE WHEN oi.fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP') THEN o.delivery_total ELSE 0 END
  FROM orders o
  JOIN (SELECT DISTINCT tenant_id,store_id,order_id,fulfillment_mode FROM order_items) oi
    ON oi.tenant_id=o.tenant_id AND oi.store_id=o.store_id AND oi.order_id=o.id
 WHERE NOT EXISTS (
   SELECT 1 FROM order_fulfillments f WHERE f.tenant_id=o.tenant_id AND f.store_id=o.store_id AND f.order_id=o.id AND f.fulfillment_mode=oi.fulfillment_mode
 );

INSERT INTO fulfillment_status_history(tenant_id,store_id,fulfillment_id,from_status,to_status,reason,actor_type,request_id)
SELECT f.tenant_id,f.store_id,f.id,NULL,f.status,'v0.4.0 upgrade backfill','SYSTEM','migration-004'
  FROM order_fulfillments f
 WHERE NOT EXISTS (SELECT 1 FROM fulfillment_status_history h WHERE h.tenant_id=f.tenant_id AND h.store_id=f.store_id AND h.fulfillment_id=f.id);
