# Technical Analysis — Luke Shop Backend v0.1.0

## Why this release starts with backend foundations

The Admin Web and Customer App will depend on stable identity, tenant, permission and API contracts. v0.1.0 therefore builds the data/security boundary first rather than hard-coding storefront screens against temporary data shapes.

## Architecture choice

A modular Fastify application is used as a single deployable backend. Modules are separated by domain so catalog, orders, payments, fulfillment and promotions can be added without immediately creating operationally expensive microservices.

PostgreSQL remains the source of truth. Tenant-owned records are linked to `tenant_id`; composite foreign keys are used where a relationship could otherwise accidentally cross tenant boundaries.

## Authentication

Customer and Merchant accounts are separate concepts. Both use rotating database-backed sessions and short-lived access JWTs. Customer suspension/blocking revokes active Customer sessions in the same transaction as the status change.

## Luke CS boundary

Luke CS connects only through `/v1/customer-service/*` with a tenant-bound service credential. v0.1.0 deliberately exposes only `customer.read`. Order/payment/delivery/product/digital capabilities remain false until those Shop domains exist.

## Known validation boundary

The packaging environment could not reach the public npm registry through its local npm client, so a dependency lockfile and dependency-backed runtime tests could not be generated here. Exact top-level versions are pinned in `package.json`; `START-HERE-WINDOWS.bat` generates `package-lock.json`, runs `npm ci`, then runs the source verification. Commit the generated lock before production.
