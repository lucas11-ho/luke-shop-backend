# Luke Shop Backend v0.5.0 — Test Result

## Packaging-environment results

- JavaScript syntax: **67 files PASS**
- v0.5.0 source regression: **130/130 PASS**
- v0.1.1 authentication carry-forward: **15/15 PASS**
- v0.1.2 HTTP semantics: **16/16 PASS**
- v0.2.0 catalog/inventory: **29/29 PASS**
- v0.3.0 cart/checkout/orders: **30/30 PASS**
- v0.4.0 payments/delivery/promotions: **38/38 PASS**
- v0.4.1 runtime integration: **13/13 PASS**
- commerce defaults core: **PASS**
- v0.4.2 commerce runtime reliability: **17/17 PASS**
- Luke CS policy core: **PASS**
- v0.5.0 CS connector: **43/43 PASS**

## Additional packaging checks

- migrations 001-004 exact immutable hashes: PASS
- migration 005 present and migration 006 absent: PASS
- AI tool allowlist contains eight read-only tools only: PASS
- raw long-lived credential blocked from tool gateway: PASS (source/lifecycle contract)
- customer/session/store context binding: PASS (source contract)
- nonce-hash-only replay persistence: PASS (source contract)
- no full tool result payload column in audit table: PASS

## Not claimed here

A disposable `npm install` attempt timed out against the npm registry. Therefore this environment did not run dependency-backed Fastify `app.inject()` tests, live PostgreSQL migration 005, or `npm run test:cs-connector:local`.

Required final runtime gates on Windows/CI:

```powershell
npm run test:http
npm run test:auth:local
npm run test:catalog:local
npm run test:orders:local
npm run test:commerce:local
npm run test:cs-connector:local
```
