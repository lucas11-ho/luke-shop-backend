# Technical Analysis — v0.14.0-R1 R2 Persistence Repair

## Verified failure sequence

1. Merchant or customer submits a valid image.
2. Backend validates content type/signature and creates a storage key.
3. `writeAsset()` uploads the bytes to Cloudflare R2 successfully.
4. Backend inserts a `media_assets` row with `storage_provider='R2'`.
5. Production PostgreSQL schema inherited migration 009's `CHECK (storage_provider IN ('LOCAL'))`.
6. PostgreSQL rejects the row and the transaction rolls back.
7. API returns HTTP 500, while the previously uploaded R2 object remains orphaned.

## Schema repair

Migration 016 drops only the named legacy check constraint and recreates it as:

`CHECK (storage_provider IN ('LOCAL', 'R2'))`

No existing media row is rewritten.

## Consistency repair

R2/local storage is outside the PostgreSQL transaction. To reduce orphan objects, upload handlers now execute compensating storage cleanup if DB persistence fails after a successful object write. Cleanup failure is logged with request/storage context but does not mask the original database failure.

## Security

R2 DELETE uses the same SigV4 request signer as PUT/GET. No bucket is made public and no access key is exposed to browsers. `R2_PUBLIC_BASE_URL` may remain empty when assets are served through `/v1/assets/public/:assetId`.
