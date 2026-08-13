# Test Result — Backend v0.6.0

Dependency-free source verification covers:

- migrations 001-005 immutable;
- migration 006 additive;
- tenant-scoped staff and role SQL;
- password hashing and password-reset session revocation;
- OWNER/system-role protection;
- privilege-escalation prevention;
- self-lockout and last-owner guards;
- force logout and individual-session revoke;
- audit event contracts;
- all previous auth/HTTP/catalog/orders/commerce/Luke-CS regression suites.

The live PostgreSQL acceptance gate is:

```powershell
npm run test:staff-rbac:local
```

This packaging environment does not provide PostgreSQL; the user's Windows PostgreSQL/CI run is authoritative for the live lifecycle.
