# Deployment Checklist — Luke Shop Backend v0.4.1

- [ ] Stop any existing Node process on port 4100.
- [ ] Keep PostgreSQL running; do **not** use `docker compose down -v`.
- [ ] Confirm migration 004 is already applied or run `npm run migrate` after installing the hotfix. No migration 005 is expected.
- [ ] Install v0.4.1 repair; confirm `.env`, `docker-compose.yml`, and `package-lock.json` were not overwritten.
- [ ] Run `npm run verify`.
- [ ] Run `npm run test:http`.
- [ ] Run `npm run test:auth:local`.
- [ ] Run `npm run test:catalog:local`.
- [ ] Run `npm run test:orders:local`.
- [ ] Run `npm run test:commerce:local`.
- [ ] Run `npm run dev` and verify `/health/ready`.
- [ ] Confirm storefront payment/delivery routes register successfully.
- [ ] Confirm inventory adjustment no longer raises PostgreSQL `0A000`.
