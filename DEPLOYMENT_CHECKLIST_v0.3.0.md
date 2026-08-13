# Deployment Checklist — v0.3.0

- [ ] Stop API workers before source upgrade.
- [ ] Back up PostgreSQL and verify restore procedure.
- [ ] Confirm current app is v0.2.0 and migrations 001/002 are unchanged.
- [ ] Run v0.3.0 upgrade installer.
- [ ] Confirm `.env`, `docker-compose.yml`, and `package-lock.json` were preserved.
- [ ] Run `npm run verify`.
- [ ] Run `npm run migrate` and confirm migration 003 is applied once.
- [ ] Run `npm run test:http`.
- [ ] Run `npm run test:auth:local` against development DB.
- [ ] Run `npm run test:catalog:local` against development DB.
- [ ] Run `npm run test:orders:local` against development DB.
- [ ] Start API and verify `/health/ready` reports v0.3.0.
- [ ] Schedule `npm run orders:expire` in production (recommended every 5 minutes).
- [ ] Review/commit the package lock before production.
- [ ] Run `npm audit --audit-level=high` with registry access.
- [ ] Confirm Luke CS credentials only receive approved read scopes.
- [ ] Load-test checkout/inventory contention before concurrency claims.
