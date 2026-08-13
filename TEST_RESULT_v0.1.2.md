# Test Result — Luke Shop Backend v0.1.2

## Packaging-environment results

- JavaScript syntax: PASS (32 files at pre-package test stage).
- v0.1.2 source regression: PASS (40/40).
- carried v0.1.1 authentication reliability regression: PASS (15/15).
- HTTP client-error normalizer executable test: PASS.
- v0.1.2 HTTP error semantics source guard: PASS (16/16).
- migration 001 SHA-256 unchanged: PASS.
- migration 002 absent: PASS.

## Dependency-backed runtime gate

`npm run test:http` uses Fastify injection and verifies:

- bodyless POST reaches authentication semantics rather than media-type failure;
- unsupported media type returns 415;
- malformed JSON returns 400;
- missing authentication returns 401;
- unknown route returns structured 404;
- rate limiting returns 429.

## Validation boundary

The packaging environment does not currently contain the project's npm dependencies, so `npm run test:http`, live Fastify startup, live PostgreSQL auth lifecycle and `npm audit` are not claimed as locally executed here. GitHub CI and the user's Windows project are the authoritative dependency-backed gates.
