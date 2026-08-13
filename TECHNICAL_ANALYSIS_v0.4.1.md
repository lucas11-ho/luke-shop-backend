# Technical Analysis — v0.4.1 Runtime Integration Stabilization

## Failure 1: FST_ERR_HOOK_INVALID_HANDLER

`customerCommerceRoutes` registered two routes with `preHandler:[app.requirePublicTenant]`, but the tenant plugin exposes `app.requireTenant`. Fastify therefore received `undefined` and refused to boot. The hotfix switches both storefront commerce routes to `app.requireTenant`.

## Failure 2: PostgreSQL 0A000 on inventory adjustment

The inventory item lookup used `LEFT JOIN product_variants ... FOR UPDATE`. PostgreSQL attempts to lock all lockable relations unless a target list is supplied, and it rejects locking the nullable side of an outer join. The hotfix uses `FOR UPDATE OF i`, which protects the inventory item row only. The subsequent `inventory_balances` row is still locked with its own `FOR UPDATE` before stock mutation.

## Failure 3: HTTP missing-auth contract

The bearer-parser call was inside the JWT verification `try/catch`, causing a missing Authorization header to be rewritten to `ACCESS_TOKEN_INVALID`. The hotfix calls `bearer(request)` before the verification catch. Missing credentials now preserve the stable `UNAUTHORIZED` contract, while invalid JWTs still map to `ACCESS_TOKEN_INVALID`.

## Schema compatibility

No schema change is needed. Migrations 001–004 remain immutable and migration 005 is not introduced.
