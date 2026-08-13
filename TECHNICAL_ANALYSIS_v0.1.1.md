# Technical Analysis — Luke Shop Backend v0.1.1

## Observed production-development symptom

A freshly issued Merchant access token successfully authenticated `GET /v1/merchant/me`, while `POST /v1/merchant/auth/logout` returned `500 INTERNAL_ERROR`. Direct PostgreSQL revocation of the same Merchant sessions succeeded and caused protected access to be rejected afterward.

The server-side exception for the failing logout request was not captured, so the precise old exception is intentionally not guessed.

## Repair strategy

The v0.1.0 auth guard verifies the JWT and then loads the active tenant-bound session from PostgreSQL. v0.1.1 makes that PostgreSQL result authoritative for the rest of the request: `request.auth.actorId` and `request.auth.sessionId` come from the verified database row.

Logout now uses the verified `profile.session_id` with only `tenant_id + session_id`, inside a transaction, returning the owning actor from PostgreSQL and recording an audit event. This removes redundant matching against a second actor/session copy after authentication has already proven ownership.

Refresh rotation now runs inside a transaction and obtains the matching active session row with `FOR UPDATE` before replacing the refresh-token hash. This serializes concurrent rotations for the same session.

## Fastify compatibility

Fastify v5 deprecates top-level `disableRequestLogging`. v0.1.1 uses `LogController({ disableRequestLogging })` instead.

## No schema change

Migration 001 SHA-256 remains `409325e42984e3d495a8af9b411cd3f01da610bef7cf6e2ce99bad563ccb2e19`. No migration 002 is present.
