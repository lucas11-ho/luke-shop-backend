# Deployment Checklist — v0.2.0

1. Back up the target database before applying migration 002.
2. Stop the running API before installing the source repair.
3. Keep `.env`, Docker/Compose local port changes, and production secrets unchanged.
4. Run `npm run verify`.
5. Ensure PostgreSQL is healthy.
6. Run `npm run migrate`; confirm 002 applies exactly once.
7. Run `npm run test:http`.
8. Run `npm run test:auth:local` against development PostgreSQL.
9. Run `npm run test:catalog:local` against development PostgreSQL.
10. Verify Demo Store can log in and receives catalog/inventory permissions.
11. Verify Storefront does not return DRAFT/ARCHIVED products or private media.
12. Verify Luke CS credential grants `product.read` only when explicitly selected.
13. Review `git diff` / migration SQL before commit.
14. Run GitHub CI and `npm audit --audit-level=high` before production deployment.
15. Do not use `docker compose down -v` unless intentionally deleting local database data.
