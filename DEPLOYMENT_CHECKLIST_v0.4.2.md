# Deployment Checklist — v0.4.2

1. Stop the API.
2. Back up PostgreSQL.
3. Run the v0.4.2 Windows upgrade installer.
4. Confirm `.env`, `docker-compose.yml`, and `package-lock.json` are preserved.
5. Run `npm run migrate` — it should only report `Migrations complete.`
6. Run `npm run verify`.
7. Run `npm run test:http`.
8. Run `npm run test:auth:local`.
9. Run `npm run test:catalog:local`.
10. Run `npm run test:orders:local`.
11. Run `npm run test:commerce:local`.
12. Run `npm run dev`.
13. Verify `/health/ready` returns `0.4.2-commerce-runtime-reliability-repair`.

Do not run `docker compose down -v` unless intentionally deleting development data.
