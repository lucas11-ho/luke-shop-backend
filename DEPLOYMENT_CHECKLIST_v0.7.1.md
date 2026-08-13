# Deployment Checklist — Backend v0.7.1

1. Back up PostgreSQL.
2. Confirm `DATABASE_URL` points to `luke_shop`, not `luke_shopT`.
3. Install the v0.7.1 source upgrade; `.env`, `docker-compose.yml`, and `package-lock.json` must be preserved.
4. Start PostgreSQL with `docker compose up -d postgres`.
5. Run `npm run migrate` to apply migration 008.
6. Run `npm run verify`.
7. Start backend with `npm run dev`.
8. Confirm `/health/ready` reports release `0.7.1-multi-tenant-storefront-routing`.
9. Upgrade Platform Admin v0.1.1, Client Admin v0.4.1, and Customer Web v0.2.1.
10. Test `/t/demo`, a second tenant route, draft preview, publish, and rollback.
11. Do not use `docker compose down -v` unless intentionally destroying local data.
