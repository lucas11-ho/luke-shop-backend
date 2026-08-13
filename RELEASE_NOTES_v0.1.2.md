# Luke Shop Backend v0.1.2 — HTTP Error Semantics Stabilization

Release marker: `0.1.2-http-error-semantics-stabilization`

## Why this release exists

During the validated v0.1.1 Windows logout test, a POST made by Windows PowerShell carried an unsupported media type. Fastify correctly raised a 415 client error, but the custom global error handler treated that framework error as an unexpected server failure and returned `500 INTERNAL_ERROR`.

## Fixed

- Fastify/framework 4xx errors keep their correct HTTP status instead of falling through to 500.
- `FST_ERR_CTP_INVALID_MEDIA_TYPE` -> `415 UNSUPPORTED_MEDIA_TYPE`.
- malformed JSON -> `400 INVALID_JSON`.
- body-too-large errors -> `413 PAYLOAD_TOO_LARGE`.
- generic 429 framework/plugin errors -> `429 RATE_LIMITED`.
- unknown routes -> structured `404 ROUTE_NOT_FOUND`.
- unclassified 4xx errors preserve their status using a safe generic public code/message.
- unexpected 5xx/runtime failures remain `500 INTERNAL_ERROR` and are logged server-side.

## Carried forward

The full v0.1.1 authentication reliability behavior remains: database-verified logout revocation, atomic refresh rotation, audit events, and Merchant/Customer auth lifecycle regression coverage.

## Database

No schema change. Migration `001_multi_tenant_commerce_foundation.sql` remains unchanged. Migration `002` remains reserved for v0.2.0 Catalog & Inventory.
