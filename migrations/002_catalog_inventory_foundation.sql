-- Luke Shop Backend v0.2.0 — Catalog & Inventory Foundation
-- Depends on 001_multi_tenant_commerce_foundation.sql.

INSERT INTO merchant_permissions(key, description) VALUES
('catalog.read','Read categories, products, variants, modifiers, and media'),
('catalog.write','Create and manage categories, products, variants, modifiers, and media'),
('inventory.read','Read inventory locations, balances, and ledger'),
('inventory.write','Create inventory locations and record inventory adjustments')
ON CONFLICT (key) DO NOTHING;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
  FROM merchant_roles r
  JOIN merchant_permissions p ON p.key IN ('catalog.read','catalog.write','inventory.read','inventory.write')
 WHERE r.key = 'OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  parent_id uuid,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, slug),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, parent_id) REFERENCES categories(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX categories_store_status_sort_idx ON categories(tenant_id, store_id, status, sort_order, name);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  category_id uuid,
  slug text NOT NULL,
  name text NOT NULL,
  short_description text,
  description text,
  product_type text NOT NULL CHECK (product_type IN ('PHYSICAL','FOOD','DIGITAL_IMAGE','DIGITAL_VIDEO','SERVICE')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  base_price numeric(18,4) NOT NULL DEFAULT 0 CHECK (base_price >= 0),
  compare_at_price numeric(18,4) CHECK (compare_at_price IS NULL OR compare_at_price >= 0),
  currency char(3) NOT NULL,
  track_inventory boolean NOT NULL DEFAULT false,
  low_stock_threshold bigint NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, slug),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, category_id) REFERENCES categories(tenant_id, store_id, id) ON DELETE SET NULL
);
CREATE INDEX products_store_status_created_idx ON products(tenant_id, store_id, status, created_at DESC);
CREATE INDEX products_store_type_idx ON products(tenant_id, store_id, product_type, status);

CREATE TABLE product_fulfillment_modes (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SHIPPING','LOCAL_DELIVERY','PICKUP','DIGITAL_DOWNLOAD','DIGITAL_ACCESS','NONE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, store_id, product_id, mode),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE
);

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sku text,
  barcode text,
  title text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_override numeric(18,4) CHECK (price_override IS NULL OR price_override >= 0),
  compare_at_price_override numeric(18,4) CHECK (compare_at_price_override IS NULL OR compare_at_price_override >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  track_inventory boolean NOT NULL DEFAULT false,
  low_stock_threshold bigint NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, product_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX product_variants_store_sku_unique ON product_variants(tenant_id, store_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX product_variants_product_sort_idx ON product_variants(tenant_id, store_id, product_id, status, sort_order);

CREATE TABLE product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  media_type text NOT NULL CHECK (media_type IN ('IMAGE','VIDEO')),
  visibility text NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','PRIVATE')),
  url text,
  storage_key text,
  alt_text text,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, product_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, product_id, variant_id) REFERENCES product_variants(tenant_id, store_id, product_id, id) ON DELETE CASCADE,
  CHECK ((visibility = 'PUBLIC' AND url IS NOT NULL) OR (visibility = 'PRIVATE' AND storage_key IS NOT NULL AND url IS NULL))
);
CREATE INDEX product_media_product_sort_idx ON product_media(tenant_id, store_id, product_id, status, sort_order);
CREATE UNIQUE INDEX product_media_primary_product_idx ON product_media(tenant_id, store_id, product_id)
  WHERE is_primary AND variant_id IS NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX product_media_primary_variant_idx ON product_media(tenant_id, store_id, product_id, variant_id)
  WHERE is_primary AND variant_id IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE product_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  min_selections integer NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
  max_selections integer NOT NULL DEFAULT 1 CHECK (max_selections >= 1),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, product_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE,
  CHECK (max_selections >= min_selections),
  CHECK (NOT required OR min_selections >= 1)
);
CREATE INDEX product_modifier_groups_product_idx ON product_modifier_groups(tenant_id, store_id, product_id, status, sort_order);

CREATE TABLE product_modifier_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  group_id uuid NOT NULL,
  name text NOT NULL,
  price_delta numeric(18,4) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, product_id, group_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, product_id, group_id) REFERENCES product_modifier_groups(tenant_id, store_id, product_id, id) ON DELETE CASCADE
);
CREATE INDEX product_modifier_options_group_idx ON product_modifier_options(tenant_id, store_id, product_id, group_id, status, sort_order);

CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, code),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inventory_locations_one_default_per_store ON inventory_locations(tenant_id, store_id) WHERE is_default;

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  sku text,
  track_inventory boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, product_id, variant_id) REFERENCES product_variants(tenant_id, store_id, product_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inventory_items_variant_unique ON inventory_items(tenant_id, store_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_items_simple_product_unique ON inventory_items(tenant_id, store_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX inventory_items_store_sku_unique ON inventory_items(tenant_id, store_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE inventory_balances (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  on_hand bigint NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, store_id, inventory_item_id, location_id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES inventory_items(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES inventory_locations(tenant_id, store_id, id) ON DELETE RESTRICT
);
CREATE INDEX inventory_balances_location_idx ON inventory_balances(tenant_id, store_id, location_id, inventory_item_id);

CREATE TABLE inventory_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('RECEIVE','RETURN','ADJUSTMENT','DAMAGE','SALE','RESERVE','RELEASE')),
  on_hand_delta bigint NOT NULL DEFAULT 0,
  reserved_delta bigint NOT NULL DEFAULT 0,
  on_hand_after bigint NOT NULL CHECK (on_hand_after >= 0),
  reserved_after bigint NOT NULL CHECK (reserved_after >= 0 AND reserved_after <= on_hand_after),
  reason text,
  reference_type text,
  reference_id text,
  actor_type text NOT NULL CHECK (actor_type IN ('MERCHANT','PLATFORM','SYSTEM')),
  actor_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES inventory_items(tenant_id, store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, store_id, location_id) REFERENCES inventory_locations(tenant_id, store_id, id) ON DELETE RESTRICT,
  CHECK (on_hand_delta <> 0 OR reserved_delta <> 0)
);
CREATE INDEX inventory_ledger_item_created_idx ON inventory_ledger(tenant_id, store_id, inventory_item_id, created_at DESC, id DESC);
CREATE INDEX inventory_ledger_location_created_idx ON inventory_ledger(tenant_id, store_id, location_id, created_at DESC, id DESC);

-- Every existing store gets a safe default inventory location. New tenant bootstrap also creates one explicitly.
INSERT INTO inventory_locations(id, public_id, tenant_id, store_id, code, name, status, is_default)
SELECT gen_random_uuid(), 'loc_' || encode(gen_random_bytes(12), 'hex'), s.tenant_id, s.id, 'MAIN', 'Main Inventory', 'ACTIVE', true
  FROM stores s
 WHERE NOT EXISTS (
   SELECT 1 FROM inventory_locations l WHERE l.tenant_id = s.tenant_id AND l.store_id = s.id AND l.is_default
 );
