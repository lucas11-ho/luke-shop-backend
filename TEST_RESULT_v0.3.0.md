# Test Result — v0.3.0

## Packaging environment

Passed:

- JavaScript syntax check for source/test files;
- v0.3.0 foundation source regression;
- v0.1.1 authentication carry-forward source guard;
- v0.1.2 HTTP semantics carry-forward source guard;
- v0.2.0 catalog/inventory carry-forward source guard;
- v0.3.0 order state-machine unit test;
- v0.3.0 cart/checkout/orders source regression;
- migration 001 immutable hash check;
- migration 002 immutable hash check.

## Runtime tests supplied

- `npm run test:orders:local`
- `npm run test:orders-db`
- `npm run orders:expire`

The live order test covers cart -> checkout -> idempotency -> inventory reserve -> paid sale -> physical status progression -> cancellation release -> Luke CS ownership isolation -> audit/ledger durability.

## Validation boundary

The packaging environment does not provide a PostgreSQL service or installed npm dependency tree. Therefore no claim is made here that migration 003 or the live PostgreSQL lifecycle test executed in the packaging environment. Windows local testing and CI are the dependency/database-backed release gates.

## Upgrade dry-run

A simulated v0.2.0 -> v0.3.0 source upgrade passed for all 34 payload files while preserving a local `.env`, a custom `127.0.0.1:5433:5432` Docker mapping, and a local `package-lock.json`. The dry-installed tree also passed `npm run verify`.
