# Release Notes — Luke Shop Backend v0.6.0

## Merchant Staff & RBAC Management

- Added migration `006_merchant_staff_rbac_management.sql`.
- Added five merchant access-management permissions and granted them to existing OWNER roles.
- Added public IDs for merchant roles and sessions.
- Added explicit `DISABLED` merchant status while retaining legacy `BLOCKED` compatibility.
- Added staff CRUD-lite lifecycle APIs (create/read/update; disable instead of destructive delete).
- Added custom role CRUD, permission replacement, and staff-role assignment.
- Added password reset, force logout, session list, and individual session revoke.
- Added tenant isolation, privilege-escalation, OWNER protection, self-lockout protection, and audit contracts.
- Added live PostgreSQL lifecycle test command `npm run test:staff-rbac:local`.

No commerce, payment, delivery, promotion, or Luke CS write capability is added in this release.
