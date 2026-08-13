# Technical Analysis — v0.4.2

The Windows live tests exposed runtime-only gaps that source-regression checks could not prove.

1. `promotion_codes pc JOIN promotions p` selected `public_id` without a table qualifier. Both relations expose that column, so PostgreSQL returned `42702`.
2. Fulfillment history also selected joined history columns without aliases. They are now explicitly qualified with `h.`.
3. Migration 004 backfilled defaults only for stores existing at migration time. Temporary/new stores created after the migration need the same defaults through application code. The new helper is idempotent and reused by bootstrap/test fixtures.
4. Public catalog media deliberately strips internal storage and visibility fields. The live test now verifies omission and absence of private-path leakage instead of requiring `storage_key: null`.

No checkout behavior silently creates merchant configuration. Store provisioning remains the owner of default creation.
