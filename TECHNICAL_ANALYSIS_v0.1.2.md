# Technical Analysis — Luke Shop Backend v0.1.2

## Observed failure

A live Windows request produced Fastify error `FST_ERR_CTP_INVALID_MEDIA_TYPE` with HTTP status 415 before the logout handler executed. The root global error handler handled only `AppError`, schema validation and PostgreSQL uniqueness explicitly; every other error was converted to `500 INTERNAL_ERROR`.

## Repair

`src/core/errors.js` now contains a narrow `normalizeHttpClientError(error)` boundary:

1. only integer status codes 400–499 are eligible;
2. known Fastify parser errors receive stable Luke Shop codes/messages;
3. standard client statuses receive safe generic codes/messages;
4. 5xx/unclassified errors return `null` and continue to the existing internal-error path.

`src/app.js` applies this normalization after application/schema/database-conflict handling and before the generic 500 fallback. It also installs a structured not-found handler.

## Security properties

- client mistakes no longer create false server-failure telemetry;
- raw Fastify parser messages/stacks are not returned;
- unknown 5xx failures are not downgraded to 4xx;
- `request_id` stays in normalized errors for server-side correlation;
- authentication/session logic is not changed by this release.

## Regression strategy

- dependency-free source checks validate handler order and mappings;
- dependency-free executable tests validate the client-error normalizer directly;
- dependency-backed `app.inject()` tests cover bodyless logout, unsupported media type, malformed JSON, missing auth, unknown route and rate limiting;
- existing PostgreSQL auth lifecycle remains in CI.
