-- Luke Shop Backend v0.7.0 — Platform Control Plane + Storefront Experience
-- Additive migration. Migrations 001-006 remain immutable.

CREATE TABLE platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN')),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (
  id uuid PRIMARY KEY,
  platform_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  user_agent text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX platform_sessions_actor_idx ON platform_sessions(platform_user_id, expires_at DESC);

CREATE TABLE platform_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  target_type text,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_ip inet,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_logs_created_idx ON platform_audit_logs(created_at DESC);
CREATE INDEX platform_audit_logs_tenant_idx ON platform_audit_logs(tenant_id, created_at DESC);

CREATE TABLE platform_plans (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  modules jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_plans(key,name,description,status,modules,limits,capabilities) VALUES
('STARTER','Starter','Core storefront for small merchants','ACTIVE',
 '{"products":true,"inventory":true,"delivery":true,"promotions":true,"restaurant":false,"digital_products":false,"luke_cs":false,"luke_ai":false}'::jsonb,
 '{"stores":1,"staff":5,"products":500}'::jsonb,
 '{"customer_web":true,"customer_mobile":true,"custom_domain":false,"home_builder":false,"advanced_theme":false}'::jsonb),
('PROFESSIONAL','Professional','Advanced commerce and customer-experience controls','ACTIVE',
 '{"products":true,"inventory":true,"delivery":true,"promotions":true,"restaurant":true,"digital_products":true,"luke_cs":true,"luke_ai":false}'::jsonb,
 '{"stores":5,"staff":25,"products":5000}'::jsonb,
 '{"customer_web":true,"customer_mobile":true,"custom_domain":true,"home_builder":true,"advanced_theme":true}'::jsonb),
('BUSINESS','Business','Full platform capability for larger tenants','ACTIVE',
 '{"products":true,"inventory":true,"delivery":true,"promotions":true,"restaurant":true,"digital_products":true,"luke_cs":true,"luke_ai":true}'::jsonb,
 '{"stores":100,"staff":500,"products":100000}'::jsonb,
 '{"customer_web":true,"customer_mobile":true,"custom_domain":true,"home_builder":true,"advanced_theme":true,"api_access":true}'::jsonb)
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,status=EXCLUDED.status,
  modules=EXCLUDED.modules,limits=EXCLUDED.limits,capabilities=EXCLUDED.capabilities,updated_at=now();

CREATE TABLE tenant_platform_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_key text NOT NULL REFERENCES platform_plans(key) ON DELETE RESTRICT DEFAULT 'STARTER',
  modules jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_platform_profiles(tenant_id,plan_key,modules,limits,capabilities)
SELECT t.id,'BUSINESS',COALESCE(s.modules,'{}'::jsonb),'{}'::jsonb,
 '{"customer_web":true,"customer_mobile":true,"custom_domain":true,"home_builder":true,"advanced_theme":true}'::jsonb
FROM tenants t JOIN tenant_settings s ON s.tenant_id=t.id
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE platform_storefront_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  business_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  config jsonb NOT NULL,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_storefront_templates(public_id,key,name,business_type,status,config)
VALUES
('tpl_default_modern','MODERN_COMMERCE','Modern Commerce','GENERAL','ACTIVE',
 '{"theme":{"preset":"modern","primary":"#166534","secondary":"#111827","background":"#f8fafc","surface":"#ffffff","text":"#172033","radius":"medium"},"branding":{"announcement":"","hero_title":"","hero_subtitle":""},"navigation":["home","explore","cart","orders","profile"],"home":{"sections":[{"id":"hero","type":"hero","enabled":true},{"id":"categories","type":"categories","enabled":true},{"id":"featured","type":"featured_products","enabled":true}]}}'::jsonb),
('tpl_restaurant_modern','RESTAURANT_MODERN','Restaurant Modern','RESTAURANT','ACTIVE',
 '{"theme":{"preset":"restaurant","primary":"#b45309","secondary":"#431407","background":"#fffaf5","surface":"#ffffff","text":"#292524","radius":"large"},"branding":{"announcement":"","hero_title":"Fresh food, ready when you are","hero_subtitle":"Browse the menu and order from your favorite store."},"navigation":["home","explore","cart","orders","profile"],"home":{"sections":[{"id":"hero","type":"hero","enabled":true},{"id":"categories","type":"categories","enabled":true},{"id":"featured","type":"featured_products","enabled":true},{"id":"promo","type":"promotion_banner","enabled":false,"title":"Today’s offer","body":"Add a promotion from Client Admin."}]}}'::jsonb),
('tpl_fashion_modern','FASHION_MODERN','Fashion Modern','FASHION','ACTIVE',
 '{"theme":{"preset":"fashion","primary":"#7c3aed","secondary":"#18181b","background":"#fafafa","surface":"#ffffff","text":"#18181b","radius":"medium"},"branding":{"announcement":"","hero_title":"New season, new favorites","hero_subtitle":"Discover the latest collection."},"navigation":["home","explore","cart","orders","profile"],"home":{"sections":[{"id":"hero","type":"hero","enabled":true},{"id":"categories","type":"categories","enabled":true},{"id":"featured","type":"featured_products","enabled":true},{"id":"new","type":"new_arrivals","enabled":true}]}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE storefront_experience_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('DRAFT','PUBLISHED','ARCHIVED')),
  config jsonb NOT NULL,
  template_key text,
  created_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES merchant_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(tenant_id,store_id,version),
  UNIQUE(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX storefront_experience_one_draft_idx
  ON storefront_experience_versions(tenant_id,store_id) WHERE state='DRAFT';
CREATE UNIQUE INDEX storefront_experience_one_published_idx
  ON storefront_experience_versions(tenant_id,store_id) WHERE state='PUBLISHED';
CREATE INDEX storefront_experience_history_idx
  ON storefront_experience_versions(tenant_id,store_id,version DESC);


-- Backfill a safe published + draft experience for existing primary stores so upgraded tenants
-- can use Customer Experience immediately without manual provisioning.
INSERT INTO storefront_experience_versions(
  id,public_id,tenant_id,store_id,version,state,config,template_key,published_at
)
SELECT gen_random_uuid(), 'sfx_' || replace(gen_random_uuid()::text,'-',''),
       s.tenant_id, s.id, 1, 'PUBLISHED',
       jsonb_set(tpl.config, '{branding,store_name}', to_jsonb(s.name), true),
       tpl.key, now()
FROM stores s
JOIN platform_storefront_templates tpl ON tpl.key='MODERN_COMMERCE' AND tpl.status='ACTIVE'
WHERE s.is_primary=true
  AND NOT EXISTS (
    SELECT 1 FROM storefront_experience_versions x
    WHERE x.tenant_id=s.tenant_id AND x.store_id=s.id
  );

INSERT INTO storefront_experience_versions(
  id,public_id,tenant_id,store_id,version,state,config,template_key
)
SELECT gen_random_uuid(), 'sfx_' || replace(gen_random_uuid()::text,'-',''),
       p.tenant_id, p.store_id, 2, 'DRAFT', p.config, p.template_key
FROM storefront_experience_versions p
WHERE p.state='PUBLISHED' AND p.version=1
  AND NOT EXISTS (
    SELECT 1 FROM storefront_experience_versions d
    WHERE d.tenant_id=p.tenant_id AND d.store_id=p.store_id AND d.state='DRAFT'
  );

INSERT INTO merchant_permissions(key, description) VALUES
('customer_experience.read','Read storefront and customer-app experience configuration'),
('customer_experience.manage','Edit storefront and customer-app draft configuration'),
('customer_experience.publish','Publish or roll back storefront and customer-app experience')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO merchant_role_permissions(role_id, permission_key)
SELECT r.id, p.key
FROM merchant_roles r
JOIN merchant_permissions p ON p.key IN (
  'customer_experience.read','customer_experience.manage','customer_experience.publish'
)
WHERE r.key='OWNER'
ON CONFLICT DO NOTHING;
