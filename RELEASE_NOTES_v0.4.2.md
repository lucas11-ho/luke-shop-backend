# Luke Shop Backend v0.4.2 — Commerce Runtime Reliability Repair

## Fixed
- PostgreSQL `42702` ambiguity in promotion detail code query.
- Potential fulfillment-history `created_at` ambiguity after joined delivery reads.
- v0.3 order lifecycle fixtures missing v0.4 payment/delivery defaults.
- Catalog lifecycle test expected private implementation fields instead of the safer public serializer contract.

## Architecture
A shared `ensureStoreCommerceDefaults(client, { tenantId, storeId })` now provisions default commerce configuration idempotently using `(tenant_id, store_id, code)` conflict protection.

## Database
No migration 005. Migrations 001-004 are unchanged and migration 004 stays applied.
