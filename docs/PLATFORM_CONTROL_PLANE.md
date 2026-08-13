# Platform Control Plane

## Hierarchy
Luke Platform Owner → Client Tenant → Tenant Owner/Admin/Staff → Stores → Customers.

Platform Owner uses `/v1/platform/*` and a dedicated platform session. Tenant operators continue using `/v1/merchant/*`. Platform credentials are never tenant credentials.

## Provisioning
`POST /v1/platform/tenants` creates a tenant with plan/template, primary store, tenant OWNER, RBAC defaults, commerce defaults, and published/draft customer experience.

## Commercial controls
Plans define default modules, limits, and capabilities. Per-tenant profile overrides allow the Platform Owner to enable/disable capabilities without exposing platform-wide configuration to clients.
