# Deployment Checklist — Backend v0.7.0

1. Back up PostgreSQL.
2. Confirm migrations 001–006 have not been edited.
3. Install the v0.7.0 source update; preserve local `.env`, `docker-compose.yml`, and `package-lock.json`.
4. Verify `.env` uses the correct database name `luke_shop` (not `luke_shopT`).
5. Preserve your local PostgreSQL mapping. On your current Windows setup it is `127.0.0.1:5433 -> 5432`; the generic complete-source compose example remains `5432 -> 5432`.
6. Run `npm run migrate` explicitly. The installer does not run migrations.
7. Create the first Platform Owner explicitly:
   `npm run bootstrap:platform-owner -- --email YOUR_EMAIL --password "YOUR_STRONG_PASSWORD" --name "Luke Platform Owner"`
8. Set local CORS for all three web apps when needed:
   `CORS_ORIGINS=http://localhost:4172,http://localhost:4173,http://localhost:4174`
9. Start backend and verify `/health/live` and `/health/ready`.
10. Log into Platform Admin, create/test a client tenant, then test Client Admin draft/publish/rollback and Customer Web rendering.
11. Review platform and tenant audit logs.
