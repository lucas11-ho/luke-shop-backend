# Test Result — Luke Shop Backend v0.1.1

## Packaging-environment results

- JavaScript syntax: PASS (29 files).
- v0.1.1 source regression: PASS (35/35).
- v0.1.1 authentication reliability regression: PASS (15/15).
- Migration 001 SHA-256 unchanged: PASS.
- No migration 002: PASS.
- Deprecated top-level Fastify `disableRequestLogging`: absent.

## New live CI gate

`scripts/auth-lifecycle-test.mjs` uses Fastify injection plus disposable PostgreSQL and verifies both actor types:

1. login/register creates a session;
2. protected identity read succeeds;
3. refresh token rotates;
4. old refresh token replay is rejected;
5. logout succeeds;
6. access token is rejected after logout with inactive-session semantics;
7. current refresh token is rejected after logout;
8. refresh/logout audit events are durable.

## Validation boundary

The packaging environment could not complete dependency installation from npm, so the live Fastify/PostgreSQL auth lifecycle was not executed locally. GitHub CI and the user's Windows environment remain authoritative for the dependency-backed lifecycle test.
