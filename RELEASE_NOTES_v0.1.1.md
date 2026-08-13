# Luke Shop Backend v0.1.1 — Authentication Reliability Repair

Release marker: `0.1.1-authentication-reliability-repair`

## Scope

This is a maintenance/security-reliability release over v0.1.0. It does not add catalog, orders, payments, delivery, or additional Luke CS data capabilities.

## Fixed

- Merchant logout no longer depends on a second copy of actor/session identifiers from JWT claims after the authentication guard has already verified the session in PostgreSQL.
- Customer logout uses the same database-verified session revocation model.
- Logout runs in a database transaction and records a durable audit event.
- Merchant and Customer refresh-token rotation now locks the selected session row with `FOR UPDATE`, preventing concurrent refresh requests from both rotating the same token successfully.
- Refresh operations record audit events.
- Fastify request logging uses the v5 `LogController` API instead of deprecated top-level `disableRequestLogging`.
- CI now performs a live PostgreSQL Merchant and Customer login → refresh → logout lifecycle test.

## Database

Migration `001_multi_tenant_commerce_foundation.sql` is unchanged byte-for-byte. No migration `002` is introduced or applied.

## Important validation note

The original Windows `INTERNAL_ERROR` stack was not captured, so this release does not claim a specific PostgreSQL exception as the root cause. It replaces the fragile logout path with a database-verified session path and adds a live regression that must prove the complete lifecycle on CI/Windows.
