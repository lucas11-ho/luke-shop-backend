# Deployment Checklist — Luke Shop Backend v0.1.2

- [ ] Stop the running development API before installing the repair.
- [ ] Run the repair installer against a v0.1.1/v0.1.2 target.
- [ ] Confirm local `.env`, `docker-compose.yml`, `package-lock.json` and PostgreSQL volume were not replaced.
- [ ] Run `npm run migrate` — no new migration should apply.
- [ ] Run `npm run verify`.
- [ ] Run `npm run test:http`.
- [ ] With development PostgreSQL running, run `npm run test:auth:local`.
- [ ] Start `npm run dev` and confirm `/health/ready` reports `0.1.2-http-error-semantics-stabilization`.
- [ ] Confirm invalid form media type returns 415 rather than 500.
- [ ] Confirm JSON logout returns 200 and token reuse returns 401.
- [ ] Run dependency audit before production.
- [ ] Review Git diff/commit history before push/deploy.

No migration `002` is part of this release.
