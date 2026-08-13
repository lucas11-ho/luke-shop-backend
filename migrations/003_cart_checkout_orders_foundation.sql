-- Luke Shop Backend v0.3.0 — Cart, Checkout & Orders
-- Depends on 001_multi_tenant_commerce_foundation.sql and 002_catalog_inventory_foundation.sql.

INSERT INTO merchant_permissions(key, description) VALUES
('orders.read','Read customer carts, checkout results, orders, items, and status history'),
('orders.manage','Manage order state transitions and fulfillment lifecycle')
ON CONFLICT (key) DO NOTHING;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
  FROM merchant_roles r
  JOIN merchant_permissions p ON p.key IN ('orders.read','orders.manage')
 WHERE r.key = 'OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CHECKED_OUT','ABANDONED')),
  currency char(3) NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX carts_one_active_per_customer_store ON carts(tenant_id, store_id, customer_id) WHERE status='ACTIVE';
CREATE INDEX carts_customer_created_idx ON carts(tenant_id, customer_id, created_at DESC);

CREATE TABLE cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  cart_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE')),
  title_snapshot text NOT NULL,
  variant_title_snapshot text,
  sku_snapshot text,
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  modifier_total numeric(18,4) NOT NULL DEFAULT 0,
  selected_modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_total numeric(18,4) NOT NULL CHECK (line_total >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, cart_id, id),
  FOREIGN KEY (tenant_id, store_id, cart_id) REFERENCES carts(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, product_id, variant_id) REFERENCES product_variants(tenant_id, store_id, product_id, id) ON DELETE RESTRICT
);
CREATE INDEX cart_items_cart_idx ON cart_items(tenant_id, store_id, cart_id, created_at, id);

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  cart_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','COMPLETED','EXPIRED','CANCELLED')),
  currency char(3) NOT NULL,
  subtotal numeric(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  delivery_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (delivery_total >= 0),
  tax_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  shipping_address jsonb,
  customer_note text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, customer_id, idempotency_key),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, cart_id) REFERENCES carts(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX checkout_sessions_customer_created_idx ON checkout_sessions(tenant_id, customer_id, created_at DESC);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  order_number text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  checkout_session_id uuid,
  order_type text NOT NULL CHECK (order_type IN ('PHYSICAL','FOOD','DIGITAL','SERVICE','MIXED')),
  status text NOT NULL CHECK (status IN (
    'PENDING_PAYMENT','PAID','CONFIRMED','RESTAURANT_ACCEPTED','PREPARING','READY','PROCESSING','PACKED',
    'PICKED_UP','SHIPPED','OUT_FOR_DELIVERY','ACCESS_GRANTED','AVAILABLE_FOR_DOWNLOAD','DELIVERED','COMPLETED',
    'CANCELLED','PAYMENT_FAILED','REFUND_PENDING','REFUNDED'
  )),
  payment_status text NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUND_PENDING','REFUNDED')),
  currency char(3) NOT NULL,
  subtotal numeric(18,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  delivery_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (delivery_total >= 0),
  tax_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total numeric(18,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  customer_note text,
  reservation_expires_at timestamptz DEFAULT (now() + interval '30 minutes'),
  cancelled_at timestamptz,
  paid_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, checkout_session_id) REFERENCES checkout_sessions(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX orders_customer_created_idx ON orders(tenant_id, customer_id, created_at DESC);
CREATE INDEX orders_store_status_created_idx ON orders(tenant_id, store_id, status, created_at DESC);
CREATE INDEX orders_reservation_expiry_idx ON orders(tenant_id, reservation_expires_at) WHERE status IN ('PENDING_PAYMENT','PAYMENT_FAILED') AND reservation_expires_at IS NOT NULL;
CREATE INDEX orders_number_tenant_idx ON orders(tenant_id, order_number);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  inventory_item_id uuid,
  inventory_location_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE')),
  title_snapshot text NOT NULL,
  variant_title_snapshot text,
  sku_snapshot text,
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  modifier_total numeric(18,4) NOT NULL DEFAULT 0,
  selected_modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_total numeric(18,4) NOT NULL CHECK (line_total >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, order_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, product_id, variant_id) REFERENCES product_variants(tenant_id, store_id, product_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES inventory_items(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, inventory_location_id) REFERENCES inventory_locations(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX order_items_order_idx ON order_items(tenant_id, store_id, order_id, created_at, id);

CREATE TABLE order_addresses (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  recipient_name text NOT NULL,
  phone text,
  country_code char(2) NOT NULL,
  state text,
  city text NOT NULL,
  postal_code text,
  address_line_1 text NOT NULL,
  address_line_2 text,
  delivery_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE CASCADE
);

CREATE TABLE order_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM','LUKE_CS')),
  actor_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE CASCADE
);
CREATE INDEX order_status_history_order_idx ON order_status_history(tenant_id, store_id, order_id, created_at, id);

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz,
  UNIQUE(tenant_id, store_id, order_item_id, inventory_item_id, location_id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, order_id, order_item_id) REFERENCES order_items(tenant_id, store_id, order_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES inventory_items(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES inventory_locations(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX inventory_reservations_order_idx ON inventory_reservations(tenant_id, store_id, order_id, status);
CREATE INDEX inventory_reservations_item_idx ON inventory_reservations(tenant_id, store_id, inventory_item_id, location_id, status);
