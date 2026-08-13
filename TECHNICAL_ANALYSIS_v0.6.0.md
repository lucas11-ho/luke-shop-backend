# Technical Analysis — Backend v0.6.0

The existing schema already contained merchant users, roles, permissions, role assignments, and sessions. v0.6.0 deliberately extends that foundation instead of replacing it.

Migration 006 is backward-aware: role/session public IDs receive database defaults so the v0.5.0 code path can still insert rows if source rollback is required after the schema migration. Existing migration files 001-005 remain byte-for-byte unchanged.

Effective permissions are reloaded by the merchant auth guard from PostgreSQL on every request. Therefore role changes take effect without waiting for the access JWT to expire. Status suspension/disable and explicit security operations additionally revoke stored sessions.

The API does not implement destructive staff deletion. Operational removal is `DISABLED`, preserving audit/history references. System OWNER is immutable through the public role-management endpoints.
