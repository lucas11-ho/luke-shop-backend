# Luke Shop Backend v0.4.1 — Runtime Integration Stabilization

## Purpose

Repair three runtime defects discovered during Windows/live PostgreSQL validation of v0.4.0 without changing the v0.4 database schema.

## Repairs

1. **Fastify route registration** — storefront payment and delivery routes used undefined `app.requirePublicTenant`; they now use the existing `app.requireTenant` guard.
2. **PostgreSQL inventory row locking** — inventory adjustment joined optional variants and used plain `FOR UPDATE`, which PostgreSQL rejects on the nullable side of an outer join. The query now uses `FOR UPDATE OF i`; the balance row continues to be locked independently before mutation.
3. **Missing bearer semantics** — the auth guard now parses the bearer header outside the JWT-verification catch. Missing credentials remain `UNAUTHORIZED`; malformed or expired tokens remain `ACCESS_TOKEN_INVALID`.

## Database

- No migration 005.
- Migrations 001–004 are unchanged.
- Existing migration 004 installations are compatible; no rollback is required.

## Runtime gates required on Windows

`npm run verify`, `npm run test:http`, `npm run test:auth:local`, `npm run test:catalog:local`, `npm run test:orders:local`, `npm run test:commerce:local`, then `npm run dev` and `/health/ready`.
