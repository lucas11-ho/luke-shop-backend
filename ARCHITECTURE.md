# Luke Shop Backend v0.6.0 — Staff/RBAC Architecture

Merchant authorization remains database-backed on every authenticated request:

1. Access JWT identifies merchant, tenant, and session.
2. Auth guard validates the live session and active merchant status.
3. Role assignments and effective permissions are re-read from PostgreSQL.
4. Route permission guards enforce the requested action.
5. Sensitive staff/RBAC mutations run in transactions and write audit events.

## Privilege boundaries

- Tenant A cannot query or mutate Tenant B merchant users/roles/sessions.
- System OWNER role cannot be edited/deleted.
- Only an OWNER may assign/manage another OWNER.
- Custom-role permissions must be a subset of the acting merchant's effective permissions unless the actor is OWNER.
- Last-active-owner and self-lockout guards preserve administrative access.
- Status disable/suspend, password reset, force logout, and session revoke invalidate live merchant sessions in PostgreSQL.

Migration 006 adds only staff/RBAC metadata and permissions; commerce and Luke CS schemas are unchanged.

## Platform control plane
The platform layer is above tenant administration and uses separate platform authentication. Customer experience is versioned server-driven configuration: Platform template → tenant draft → published version → Customer Web/Mobile renderer.
