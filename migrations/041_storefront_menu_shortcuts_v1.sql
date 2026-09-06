-- Luke Shop Backend v0.15.0 — Storefront Menu Shortcuts v1 (A9.2)
-- Depends on 038_platform_icon_library_v1.sql and existing tenant/store foundations.

CREATE TABLE storefront_menu_shortcuts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  destination text NOT NULL CHECK (destination IN ('HOME','EXPLORE','CART','ORDERS','PROFILE')),
  icon_key text REFERENCES platform_icons(key) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX storefront_menu_shortcuts_store_status_sort_idx
  ON storefront_menu_shortcuts(tenant_id, store_id, status, sort_order, created_at);
