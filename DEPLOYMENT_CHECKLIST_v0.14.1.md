# Deployment Checklist — Backend v0.14.1

## Before deploy
- [ ] Migration 016 has been applied to the Shop production database if R2 is enabled.
- [ ] `CUSTOMER_GOOGLE_CLIENT_ID` is the Google Web Client ID.
- [ ] `CUSTOMER_TELEGRAM_CLIENT_ID` is the numeric Client ID from BotFather Web Login.
- [ ] `CUSTOMER_TELEGRAM_BOT_USERNAME` is configured for recognizable Telegram UI.
- [ ] `CUSTOMER_TURNSTILE_ENABLED=true`.
- [ ] `CUSTOMER_TURNSTILE_SITE_KEY` is configured.
- [ ] `CUSTOMER_TURNSTILE_SECRET_KEY` is configured only on Backend.
- [ ] `CUSTOMER_TURNSTILE_HOSTNAMES=luke-shop-customer-web.lacus-mm-ph.workers.dev` (plus approved custom storefront hosts later).
- [ ] `CUSTOMER_TURNSTILE_LOGIN_REQUIRED=true`.
- [ ] `CUSTOMER_TURNSTILE_SIGNUP_REQUIRED=true`.
- [ ] `CUSTOMER_TURNSTILE_SOCIAL_REQUIRED=false` initially.
- [ ] Existing JWT, database, R2, Commerce Connector and CORS secrets remain present.

## Deploy order
1. Backend v0.14.1.
2. Customer Web v0.9.1.
3. Merchant Admin v0.12.1.

## Acceptance
- [ ] `/v1/customer/auth/options` reports Google/Telegram readiness without any secret.
- [ ] Turnstile appears for email sign in/sign up.
- [ ] Invalid/replayed/expired Turnstile tokens are rejected.
- [ ] Google official button signs in a test account.
- [ ] Telegram official popup signs in a test account.
- [ ] Login & Security can link Google/Telegram to an authenticated account.
- [ ] Forgot Password is absent.
- [ ] Existing email/password login still works when enabled.
