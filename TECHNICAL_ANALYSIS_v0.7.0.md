# Technical Analysis — Backend v0.7.0

This release adds a control-plane boundary above tenant administration instead of overloading tenant OWNER accounts. Platform identity, sessions, audit, plans, tenant profiles, templates, and storefront-experience versions live in the Shop backend but use separate authentication and authorization paths.

Tenant provisioning remains transactional and creates the tenant, primary store, tenant owner, OWNER role/permissions, commerce defaults, integration policy, and initial published/draft experience. Existing tenants are backfilled by migration 007.

Customer Experience is server-driven but not arbitrary-code driven. The backend normalizes an allowlist of navigation keys, theme tokens, branding fields, and supported home components. The storefront reads only `state='PUBLISHED'`.

No direct Luke CS SQL access is introduced. Existing commerce, RBAC, customer auth, and connector boundaries remain intact.
