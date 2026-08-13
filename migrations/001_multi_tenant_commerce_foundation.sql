CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE CHECK (slug = lower(slug)),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'USD',
  locale text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  modules jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_service jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, id)
);
CREATE UNIQUE INDEX stores_one_primary_per_tenant ON stores(tenant_id) WHERE is_primary;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','BLOCKED','DELETION_PENDING')),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, email),
  UNIQUE(tenant_id, id)
);
CREATE INDEX customers_tenant_status_created_idx ON customers(tenant_id, status, created_at DESC);

CREATE TABLE customer_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  changed_by_type text NOT NULL CHECK (changed_by_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM')),
  changed_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_status_history_lookup_idx ON customer_status_history(tenant_id, customer_id, created_at DESC);

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  label text NOT NULL,
  recipient_name text NOT NULL,
  phone text,
  country_code char(2) NOT NULL,
  state text,
  city text NOT NULL,
  postal_code text,
  address_line_1 text NOT NULL,
  address_line_2 text,
  delivery_note text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses(tenant_id, customer_id);

CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  user_agent text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_sessions_actor_idx ON customer_sessions(tenant_id, customer_id, expires_at DESC);

CREATE TABLE merchant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','BLOCKED')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, email),
  UNIQUE(tenant_id, id)
);

CREATE TABLE merchant_permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO merchant_permissions(key, description) VALUES
('tenant.settings.read','Read tenant settings'),
('tenant.settings.write','Change tenant settings'),
('customers.read','Read tenant customers'),
('customers.status.manage','Suspend, block, or reactivate customers'),
('integrations.customer_service.read','Read Customer Service integration configuration'),
('integrations.customer_service.manage','Create or revoke Customer Service integration credentials'),
('audit.read','Read tenant audit logs')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE merchant_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, key),
  UNIQUE(tenant_id, id)
);

CREATE TABLE merchant_role_permissions (
  role_id uuid NOT NULL REFERENCES merchant_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES merchant_permissions(key) ON DELETE RESTRICT,
  PRIMARY KEY(role_id, permission_key)
);

CREATE TABLE merchant_user_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY(tenant_id, merchant_user_id, role_id),
  FOREIGN KEY (tenant_id, merchant_user_id) REFERENCES merchant_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES merchant_roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE merchant_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  user_agent text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, merchant_user_id) REFERENCES merchant_users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX merchant_sessions_actor_idx ON merchant_sessions(tenant_id, merchant_user_id, expires_at DESC);

CREATE TABLE integration_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('LUKE_CS')),
  name text NOT NULL,
  client_id text NOT NULL UNIQUE,
  secret_hash char(64) NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(tenant_id, id)
);
CREATE INDEX integration_clients_tenant_kind_idx ON integration_clients(tenant_id, kind, status);

CREATE TABLE customer_service_access_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_client_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_ref text,
  result_code text NOT NULL,
  request_id text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, integration_client_id) REFERENCES integration_clients(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_service_access_logs_lookup_idx ON customer_service_access_logs(tenant_id, created_at DESC);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER','MERCHANT','PLATFORM','SYSTEM','LUKE_CS')),
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_ip inet,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_created_idx ON audit_logs(tenant_id, created_at DESC);
