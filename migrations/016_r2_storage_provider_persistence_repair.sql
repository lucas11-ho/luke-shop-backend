-- Luke Shop v0.14.0-R1 — R2 storage provider persistence repair.
-- Migration 009 originally constrained media_assets.storage_provider to LOCAL only.
-- The production R2 adapter introduced later writes storage_provider='R2', so the
-- database must explicitly allow both durable providers without changing old rows.

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_storage_provider_check;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_storage_provider_check
  CHECK (storage_provider IN ('LOCAL', 'R2'));
