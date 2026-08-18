# Luke Shop Backend v0.14.0-R1 — R2 Persistence Repair

This hotfix repairs production media uploads when `ASSET_STORAGE_DRIVER=R2`.

## Root cause

Migration 009 created `media_assets.storage_provider` with a check constraint that accepted only `LOCAL`. The later R2 adapter correctly uploaded bytes to Cloudflare R2 and then persisted `storage_provider='R2'`; PostgreSQL rejected that row, so the API returned HTTP 500 even though the object had already reached R2.

## Repair

- Adds migration `016_r2_storage_provider_persistence_repair.sql`.
- Allows `media_assets.storage_provider` values `LOCAL` and `R2`.
- Preserves migration 009 unchanged.
- Adds compensating storage deletion if merchant asset metadata cannot be committed after the object upload.
- Adds the same compensation for customer avatar uploads.
- Adds provider-aware deletion for both R2 and local storage.
- Adds a dedicated regression guard to the normal backend verification suite.

## No frontend release required

Merchant Admin and Customer Web already call the correct upload endpoints. The failure was backend/database persistence after the R2 PUT.

## Existing orphan R2 objects

Objects created by earlier failed API requests do not have `media_assets` rows and therefore do not automatically appear in Media Library after migration 016. They may be deleted manually after the repair is confirmed, or retained temporarily for forensic comparison.
