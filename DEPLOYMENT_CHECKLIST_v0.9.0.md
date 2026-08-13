# Deployment Checklist v0.9.0

1. Back up PostgreSQL.
2. Run the Windows upgrade installer; it preserves `.env`, `docker-compose.yml`, `package-lock.json`, and `.data`.
3. Confirm `DATABASE_URL` points to the intended database (`/luke_shop` locally).
4. Start PostgreSQL: `docker compose up -d postgres`.
5. Apply migration 010 explicitly: `npm run migrate`.
6. Run `npm run verify`.
7. Start backend with `npm run dev` and confirm `/health/ready` returns `ready`.
8. Upgrade Platform Admin, Client Admin, then Customer Web.

Never use `docker compose down -v` unless intentionally destroying the local database volume.
