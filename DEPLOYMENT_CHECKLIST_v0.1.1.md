# Deployment Checklist — Luke Shop Backend v0.1.1

- [ ] Back up/review the current v0.1.0 repository.
- [ ] Keep the existing `.env` and local Docker port customization; the repair package does not replace them.
- [ ] Install the v0.1.1 repair package.
- [ ] Confirm migration `001` remains unchanged; do not create/apply migration `002`.
- [ ] Run `npm run verify`.
- [ ] With local PostgreSQL available, run `npm run test:auth:local`. This creates and cleans up a temporary test tenant.
- [ ] Start `npm run dev` and confirm the Fastify `FSTDEP023` warning is gone.
- [ ] Log in as the demo Merchant, call logout, and confirm `{ logged_out: true }`.
- [ ] Confirm the logged-out access token can no longer call `/v1/merchant/me`.
- [ ] Confirm the logged-out refresh token cannot be rotated.
- [ ] Review `git diff` before commit.
- [ ] Push and require GitHub CI, including the live Authentication lifecycle step, to pass.
- [ ] Deploy only after CI is green.
