# Technical Analysis — Backend v0.14.1

## Authentication boundary

The browser never creates a Shop session solely from client-side provider data. Provider credentials are posted to Luke Shop Backend, which verifies them and then creates the normal tenant-scoped Luke customer session.

## Google identity safety

`verifyGoogleCredential()` validates the ID token with Google JWKS and the configured `CUSTOMER_GOOGLE_CLIENT_ID`. Automatic email linking is limited to Google-authoritative email cases (Gmail or Workspace `hd`). Other matching third-party emails require an already authenticated account-link action.

## Telegram identity safety

Modern Telegram Login uses `CUSTOMER_TELEGRAM_CLIENT_ID`. The public nonce endpoint returns a tenant-bound HMAC-signed nonce valid for ten minutes. The returned Telegram `id_token` must contain that same nonce and pass JWKS signature, issuer, audience and expiry checks.

`CUSTOMER_TELEGRAM_CLIENT_SECRET` is accepted as backend-only configuration for future authorization-code/PKCE use, but the current popup ID-token library flow does not expose or require it in Customer Web.

## Turnstile

Turnstile tokens are sent only inside authentication POST bodies. Backend posts them to Cloudflare Siteverify with the backend-only secret. A successful response is still rejected if its `action` does not match `login`, `signup`, or `social`, or if `hostname` is not in `CUSTOMER_TURNSTILE_HOSTNAMES`.

## No schema change

The existing migration 014 identity model already stores provider identities and JSONB authentication policy, so no migration 017 is introduced. Migration 016 remains required for R2 persistence.
