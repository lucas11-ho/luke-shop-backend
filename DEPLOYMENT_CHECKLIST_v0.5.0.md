# Luke Shop Backend v0.5.0 — Deployment Checklist

## Before upgrade

- [ ] Stop the API process.
- [ ] Confirm PostgreSQL is healthy.
- [ ] Back up the database before migration 005.
- [ ] Keep migrations 001-004 unchanged.
- [ ] Do not use `docker compose down -v` unless intentionally deleting the local database.

## Install

- [ ] Run the v0.5.0 Windows upgrade installer.
- [ ] Confirm `.env`, `docker-compose.yml`, and `package-lock.json` were preserved.
- [ ] Confirm rollback backup path is printed.
- [ ] Run `npm run migrate` manually.
- [ ] Confirm `005_cs_commerce_connector_foundation.sql` is applied once.

## Runtime verification

```powershell
npm run verify
npm run test:http
npm run test:auth:local
npm run test:catalog:local
npm run test:orders:local
npm run test:commerce:local
npm run test:cs-connector:local
```

- [ ] All six dependency-backed runtime suites pass.
- [ ] `npm run dev` starts without route-registration errors.
- [ ] `/health/ready` reports `0.5.0-luke-cs-commerce-connector-ai-tool-gateway`.

## Production security

- [ ] Set a strong `JWT_ACCESS_SECRET`.
- [ ] Set a strong `SERVICE_CREDENTIAL_PEPPER`.
- [ ] Set a strong `CS_CONTEXT_SIGNING_SECRET` (48+ chars).
- [ ] Set a different strong `CS_SERVICE_SIGNING_SECRET` (48+ chars).
- [ ] Configure CORS origins and production database pool settings.
- [ ] Create least-privilege Luke CS credentials; use `AI` only for AI tool clients.
- [ ] Leave AI read flags disabled until intentionally enabled per tenant.
- [ ] Schedule `npm run cs:cleanup`.
- [ ] Keep `npm run orders:expire` scheduled.

## Rollout

- [ ] Test one tenant with customer/product reads first.
- [ ] Enable order/payment/delivery AI reads only after validating customer/session/store binding.
- [ ] Review `customer_service_tool_calls` and `customer_service_access_logs` during rollout.
- [ ] Do not add write scopes/tools without a separate confirmation/RBAC/idempotency review.
