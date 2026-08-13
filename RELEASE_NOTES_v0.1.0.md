# Luke Shop Backend v0.1.0 — Multi-Tenant Commerce Foundation

Release marker: `0.1.0-multi-tenant-commerce-foundation`
Migration: `001_multi_tenant_commerce_foundation.sql`
Next migration: `002`

This initial release establishes the security and tenancy boundaries for the Shop backend. It deliberately does not pretend to provide Orders, Payments, Delivery, Catalog or Promotions before those schemas and state machines are implemented.

### Security choices
- tenant-scoped uniqueness and foreign-key relationships
- explicit tenant filters on Customer/Merchant/CS reads
- scrypt password hashes
- opaque rotating refresh tokens stored only as hashes
- short-lived signed access tokens
- service credentials stored only as keyed hashes
- immediate session revocation on Customer suspension/block
- RBAC permissions enforced in backend pre-handlers
- audit/access logs
- CORS/Helmet/rate-limit setup

### Luke CS foundation
- credential generation/revocation by Tenant Owner permission
- authenticated health/capability discovery
- tenant-scoped `customer.read`
- all order/payment/delivery/product/digital/write capabilities remain `false` until those Shop modules are built
