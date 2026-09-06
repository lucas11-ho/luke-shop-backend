-- Luke Shop Backend v0.15.0 - Category Icon Integration v1 A9.1
-- Additive migration. Existing migrations remain immutable.

ALTER TABLE categories ADD COLUMN icon_key text;
ALTER TABLE categories
  ADD CONSTRAINT categories_icon_key_fkey
  FOREIGN KEY (icon_key) REFERENCES platform_icons(key) ON DELETE SET NULL;

CREATE INDEX categories_icon_key_idx ON categories(icon_key) WHERE icon_key IS NOT NULL;
