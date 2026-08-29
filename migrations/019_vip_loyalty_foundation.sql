-- Luke Shop Backend v0.15.0 — VIP & Loyalty v1 Foundation
-- Additive migration after TokenPay foundation. Existing commerce contracts remain unchanged.

INSERT INTO merchant_permissions(key, description) VALUES
('loyalty.read','Read VIP program, levels, benefits, member progress, and history'),
('loyalty.manage','Manage VIP program, levels, benefits, evaluations, and manual tier assignments')
ON CONFLICT (key) DO NOTHING;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
  FROM merchant_roles r
  JOIN merchant_permissions p ON p.key IN ('loyalty.read','loyalty.manage')
 WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE vip_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  evaluation_period text NOT NULL DEFAULT 'LIFETIME' CHECK (evaluation_period IN ('LIFETIME','ROLLING_30','ROLLING_90','ROLLING_180','ROLLING_365','CALENDAR_YEAR','CUSTOM')),
  custom_period_days integer CHECK (custom_period_days IS NULL OR custom_period_days BETWEEN 1 AND 3650),
  evaluation_frequency text NOT NULL DEFAULT 'REALTIME' CHECK (evaluation_frequency IN ('REALTIME','DAILY','WEEKLY','MONTHLY','MANUAL')),
  downgrade_policy text NOT NULL DEFAULT 'REEVALUATE' CHECK (downgrade_policy IN ('NEVER','REEVALUATE')),
  grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 365),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  CHECK (evaluation_period='CUSTOM' OR custom_period_days IS NULL),
  CHECK (evaluation_period<>'CUSTOM' OR custom_period_days IS NOT NULL)
);

CREATE TABLE vip_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  program_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  badge_icon text,
  badge_color text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order integer NOT NULL DEFAULT 0,
  qualification_mode text NOT NULL CHECK (qualification_mode IN ('SPEND','ORDERS','AND','OR')),
  spend_threshold numeric(18,4),
  order_threshold integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,code),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,program_id) REFERENCES vip_programs(tenant_id,store_id,id) ON DELETE CASCADE,
  CHECK (spend_threshold IS NULL OR spend_threshold >= 0),
  CHECK (order_threshold IS NULL OR order_threshold >= 0),
  CHECK ((qualification_mode='SPEND' AND spend_threshold IS NOT NULL)
      OR (qualification_mode='ORDERS' AND order_threshold IS NOT NULL)
      OR (qualification_mode IN ('AND','OR') AND spend_threshold IS NOT NULL AND order_threshold IS NOT NULL))
);
CREATE INDEX vip_levels_store_order_idx ON vip_levels(tenant_id,store_id,status,sort_order,created_at);

CREATE TABLE vip_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  level_id uuid NOT NULL,
  name text NOT NULL,
  benefit_type text NOT NULL CHECK (benefit_type IN ('FREE_DELIVERY','CASHBACK','VOUCHER','GIFT')),
  frequency text NOT NULL CHECK (frequency IN ('TIER_ENTRY','EVERY_ORDER','MONTHLY','ANNUAL','BIRTHDAY','MANUAL')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,level_id) REFERENCES vip_levels(tenant_id,store_id,id) ON DELETE CASCADE
);
CREATE INDEX vip_benefits_level_idx ON vip_benefits(tenant_id,store_id,level_id,status,sort_order,created_at);

CREATE TABLE customer_vip_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  level_id uuid,
  assignment_source text NOT NULL DEFAULT 'AUTO' CHECK (assignment_source IN ('AUTO','MANUAL')),
  locked boolean NOT NULL DEFAULT false,
  qualified_spend numeric(18,4) NOT NULL DEFAULT 0 CHECK (qualified_spend >= 0),
  qualified_orders integer NOT NULL DEFAULT 0 CHECK (qualified_orders >= 0),
  evaluation_start timestamptz,
  evaluation_end timestamptz,
  tier_expires_at timestamptz,
  grace_until timestamptz,
  evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,store_id,customer_id),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,level_id) REFERENCES vip_levels(tenant_id,store_id,id) ON DELETE SET NULL
);
CREATE INDEX customer_vip_status_level_idx ON customer_vip_status(tenant_id,store_id,level_id,updated_at DESC);
CREATE INDEX customer_vip_status_evaluated_idx ON customer_vip_status(tenant_id,store_id,evaluated_at);

CREATE TABLE vip_tier_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  from_level_id uuid,
  to_level_id uuid,
  source text NOT NULL CHECK (source IN ('AUTO','MANUAL','ORDER','REFUND','EVALUATION','EXPIRY')),
  reason text,
  actor_type text NOT NULL CHECK (actor_type IN ('MERCHANT','SYSTEM','CUSTOMER')),
  actor_id uuid,
  source_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,store_id,from_level_id) REFERENCES vip_levels(tenant_id,store_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,store_id,to_level_id) REFERENCES vip_levels(tenant_id,store_id,id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id,store_id,source_order_id) REFERENCES orders(tenant_id,store_id,id) ON DELETE SET NULL
);
CREATE INDEX vip_tier_history_customer_idx ON vip_tier_history(tenant_id,store_id,customer_id,created_at DESC,id DESC);

-- Existing stores receive an explicitly disabled program. No customer behavior changes until a merchant enables VIP.
INSERT INTO vip_programs(id,public_id,tenant_id,store_id,enabled,evaluation_period,evaluation_frequency,downgrade_policy,grace_days)
SELECT gen_random_uuid(),'vipg_' || replace(gen_random_uuid()::text,'-',''),s.tenant_id,s.id,false,'LIFETIME','REALTIME','REEVALUATE',0
  FROM stores s
 WHERE NOT EXISTS (SELECT 1 FROM vip_programs vp WHERE vp.tenant_id=s.tenant_id AND vp.store_id=s.id);
