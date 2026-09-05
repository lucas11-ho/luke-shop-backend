-- Luke Shop Backend v0.15.0 - Platform Icon Library v1 A1
-- Additive migration. Existing migrations remain immutable.

CREATE TABLE platform_icons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('LIBRARY')),
  library_pack text NOT NULL,
  library_icon text NOT NULL,
  color_mode text NOT NULL DEFAULT 'THEME' CHECK (color_mode IN ('THEME','DUOTONE','ORIGINAL')),
  usage_scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(usage_scopes)='array'),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags)='array'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE(library_pack, library_icon)
);

CREATE INDEX platform_icons_status_idx ON platform_icons(status, name);
CREATE INDEX platform_icons_usage_scopes_idx ON platform_icons USING gin(usage_scopes);

INSERT INTO platform_icons(key,name,source_type,library_pack,library_icon,color_mode,usage_scopes,tags,status,published_at)
VALUES
('PHOSPHOR.HOUSE','House','LIBRARY','PHOSPHOR','house','THEME','["NAVIGATION","TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["home","general"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.STOREFRONT','Storefront','LIBRARY','PHOSPHOR','storefront','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["shop","commerce"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.SQUARES_FOUR','Squares Four','LIBRARY','PHOSPHOR','squares-four','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["grid","menu"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.SHOPPING_BAG','Shopping Bag','LIBRARY','PHOSPHOR','shopping-bag','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["bag","commerce"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.BASKET','Basket','LIBRARY','PHOSPHOR','basket','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["basket","commerce"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.HANDBAG','Handbag','LIBRARY','PHOSPHOR','handbag','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["fashion","bag"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.RECEIPT','Receipt','LIBRARY','PHOSPHOR','receipt','THEME','["NAVIGATION","TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["orders","receipt"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.CLIPBOARD_TEXT','Clipboard Text','LIBRARY','PHOSPHOR','clipboard-text','THEME','["NAVIGATION","TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["orders","list"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.PACKAGE','Package','LIBRARY','PHOSPHOR','package','THEME','["NAVIGATION","TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["package","delivery"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.LIST_CHECKS','List Checks','LIBRARY','PHOSPHOR','list-checks','THEME','["NAVIGATION","TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["tasks","orders"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.USER_CIRCLE','User Circle','LIBRARY','PHOSPHOR','user-circle','THEME','["NAVIGATION","TOPIC","ACCOUNT","ACTION"]'::jsonb,'["account","profile"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.USER','User','LIBRARY','PHOSPHOR','user','THEME','["NAVIGATION","TOPIC","ACCOUNT","ACTION"]'::jsonb,'["account","profile"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.HEART','Heart','LIBRARY','PHOSPHOR','heart','THEME','["TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["favorite","loyalty"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.STAR','Star','LIBRARY','PHOSPHOR','star','THEME','["TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["featured","vip"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.COMPASS','Compass','LIBRARY','PHOSPHOR','compass','THEME','["NAVIGATION","TOPIC","CATEGORY","ACTION"]'::jsonb,'["explore","discover"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.MAGNIFYING_GLASS','Magnifying Glass','LIBRARY','PHOSPHOR','magnifying-glass','THEME','["TOPIC","CATEGORY","ACTION"]'::jsonb,'["search"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.TAG','Tag','LIBRARY','PHOSPHOR','tag','THEME','["TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["promotion","price"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.GIFT','Gift','LIBRARY','PHOSPHOR','gift','DUOTONE','["TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["reward","gift","loyalty"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.BELL','Bell','LIBRARY','PHOSPHOR','bell','THEME','["TOPIC","ACCOUNT","ACTION"]'::jsonb,'["notification","alert"]'::jsonb,'PUBLISHED',now()),
('PHOSPHOR.MAP_PIN','Map Pin','LIBRARY','PHOSPHOR','map-pin','THEME','["TOPIC","CATEGORY","ACCOUNT","ACTION"]'::jsonb,'["location","delivery"]'::jsonb,'PUBLISHED',now())
ON CONFLICT (key) DO NOTHING;
