# LUKE_SHOP_BACKEND — current release v0.14.1

Luke Shop Backend v0.14.1 adds **Customer Authentication Pro** on top of Commerce Connector v2 and the R2 persistence repair.

Coordinated versions:
- Backend v0.14.1
- Merchant Admin v0.12.1
- Customer Web v0.9.1
- Platform Admin v0.6.0 unchanged
- Luke CS v1.18.0-R1 compatible
- Latest Shop migration: 016 (no migration 017)

Authentication highlights:
- Google Identity Services ID-token verification with account-link safety.
- Telegram current Login/OIDC ID-token verification with tenant-bound nonce.
- Cloudflare Turnstile server-side Siteverify with action + hostname validation.
- Merchant provider policy remains separate from backend credential readiness.
- Phone OTP remains available but is not part of this Google/Telegram-first rollout.

R2 persistence repair from v0.14.0-R1 remains carried forward.

See `RELEASE_NOTES_v0.14.1.md`, `TECHNICAL_ANALYSIS_v0.14.1.md`, `TEST_RESULT_v0.14.1.md` and `DEPLOYMENT_CHECKLIST_v0.14.1.md`.
