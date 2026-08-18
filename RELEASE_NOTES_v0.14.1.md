# Luke Shop Backend v0.14.1 — Customer Authentication Pro

Release date: 2026-08-18

## Scope

This release upgrades customer authentication without adding a new database migration. Migration 016 from the R2 persistence repair remains the latest Shop migration.

### Google
- Uses Google Identity Services ID-token authentication.
- Verifies signature, issuer, audience, expiry and verified email server-side.
- Uses Google `sub` as provider identity.
- Prevents silent account takeover when a non-Gmail/non-Workspace Google account merely shares an email address with an existing password account; the customer must first authenticate to the existing account and link Google from Login & Security.

### Telegram
- Adds current Telegram Login / OIDC support using the BotFather Client ID.
- Verifies Telegram ID tokens against the official JWKS, expected issuer and audience.
- Uses a short-lived tenant-bound signed nonce to bind the browser popup result to the Shop login attempt.
- Retains the legacy Bot Token Login Widget verifier only as a compatibility fallback.

### Cloudflare Turnstile
- Adds server-side Siteverify validation for customer email/password login and signup.
- Validates challenge success, expected action and approved storefront hostname.
- Social-login Turnstile remains independently configurable and is OFF by default.
- The Turnstile secret never appears in storefront or Merchant Admin APIs.

### Merchant policy
- Merchant auth configuration can require Turnstile for login, signup and optionally social login.
- Provider lockout protection remains active: a merchant cannot leave customers with no production-ready login method.

### R2 carry-forward
- Migration 016 and compensating asset cleanup from v0.14.0-R1 are carried forward unchanged.

## Versions
- Backend: v0.14.1
- Merchant Admin: v0.12.1
- Customer Web: v0.9.1
- Platform Admin: v0.6.0 unchanged
- Latest Shop migration: 016
