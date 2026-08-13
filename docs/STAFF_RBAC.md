# Merchant Staff & RBAC

Backend v0.6.0 exposes tenant-scoped merchant administration for Luke Shop Admin Web.

## Safe lifecycle

- Create staff instead of sharing OWNER credentials.
- Assign one or more custom roles.
- Effective permissions are re-read from PostgreSQL on every authenticated request.
- Suspend/disable, password reset, force logout, and session revoke invalidate database sessions.
- Use `DISABLED` rather than deleting staff so audit references remain intact.

## Protected rules

- `OWNER` is a system role and cannot be edited/deleted.
- Only OWNER can assign/manage OWNER membership.
- A non-OWNER cannot grant permissions they do not hold or manage an account with permissions above their own.
- Self suspend/disable and self role replacement are blocked.
- Tenant isolation is enforced in every staff/role/session query.
