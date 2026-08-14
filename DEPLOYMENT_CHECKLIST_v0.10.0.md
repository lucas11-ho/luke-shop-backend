# Deployment Checklist — Backend v0.10.0

- [ ] Confirm current production source/database are healthy on v0.9.0 / migration 010.
- [ ] Take a Neon/PostgreSQL snapshot or verified backup.
- [ ] Review migration `011_store_designer_v3.sql`; do not edit migrations 001–010.
- [ ] Ensure Render environment variables and CORS origins are unchanged/present.
- [ ] Deploy the v0.10.0 backend artifact in a maintenance-safe sequence.
- [ ] Apply migration 011 before new v0.10.0 traffic depends on the new Experience columns.
- [ ] Run `npm run verify`.
- [ ] Verify `/health/ready` and merchant authentication.
- [ ] Verify `GET /v1/merchant/stores` is tenant-scoped.
- [ ] Save a Customer Experience draft and issue a signed preview token.
- [ ] Publish and rollback one non-production test design.
- [ ] Then deploy Customer Web v0.5.0, Admin Web v0.8.0, and Platform Admin v0.3.1.
