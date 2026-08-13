# Deployment Checklist — Luke Shop Backend v0.4.0

## Before upgrade

- [ ] Confirm current source is Luke Shop Backend v0.3.0.
- [ ] Stop API/workers that mutate the database.
- [ ] Back up PostgreSQL.
- [ ] Keep the existing `.env` and secrets private.
- [ ] Do **not** run `docker compose down -v`.

## Source upgrade

- [ ] Run the v0.4.0 Windows `START-HERE-WINDOWS.bat` or apply the reviewed source upgrade.
- [ ] Confirm `.env` was not overwritten.
- [ ] Confirm local `docker-compose.yml` (including host port 5433 if used) was not overwritten.
- [ ] Confirm `package-lock.json` was not overwritten by the installer.
- [ ] Run `npm run verify`.

## Database

- [ ] Confirm PostgreSQL is healthy.
- [ ] Run `npm run migrate` explicitly.
- [ ] Confirm migration `004_payments_delivery_promotions_foundation.sql` applied once.
- [ ] Confirm migrations 001-003 still match their immutable hashes.
- [ ] Confirm existing store defaults/payment/fulfillment backfill looks reasonable.

## Runtime gates

- [ ] `npm run test:http`
- [ ] `npm run test:auth:local`
- [ ] `npm run test:catalog:local`
- [ ] `npm run test:orders:local`
- [ ] `npm run test:commerce:local`
- [ ] Start with `npm run dev` and verify `/health/ready` reports v0.4.0.

## Production review

- [ ] Configure real payment provider secrets outside tenant public configuration.
- [ ] Do not expose an unverified generic webhook.
- [ ] Review active payment/delivery methods and fees per tenant/store.
- [ ] Review promotion dates, limits, and automatic rules before activating them.
- [ ] Keep `npm run orders:expire` scheduled for stale pending-payment reservations.
