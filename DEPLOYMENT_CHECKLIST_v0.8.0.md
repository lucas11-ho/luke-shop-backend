# Deployment Checklist v0.8.0

1. Back up PostgreSQL.
2. Preserve `.env`, `docker-compose.yml`, `package-lock.json`, and `.data`.
3. Configure `ASSET_PUBLIC_BASE_URL` in production.
4. Run `npm run migrate` to apply migration 009.
5. Run `npm run verify`.
6. Start backend and test upload/list/public delivery.
