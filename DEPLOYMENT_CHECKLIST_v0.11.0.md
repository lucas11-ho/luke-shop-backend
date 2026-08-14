# Deployment Checklist — Backend v0.11.0

- [ ] Review the coordinated release notes and changed-files inventory.
- [ ] Take a Neon/PostgreSQL snapshot before schema changes.
- [ ] Apply migration `012_operations_control_completion.sql` exactly once.
- [ ] Deploy Backend v0.11.0.
- [ ] Confirm `/health/ready` reports the v0.11.0 release marker.
- [ ] Confirm existing tenant/store/auth flows remain healthy.
- [ ] Confirm Merchant Admin can list stores and retrieve audit/profile/session data.
- [ ] Confirm Customer Web can retrieve profile/addresses/sessions after authentication.
- [ ] Confirm Platform Admin can retrieve plans, typography, tenant stores and Platform Owner profile.
- [ ] Test a DNS TXT challenge against a controlled domain before relying on domain verification in production.
- [ ] Treat refund controls as internal workflow records unless a provider adapter separately executes the monetary refund.
- [ ] Do not put payment/delivery provider secrets into public configuration fields.

The coordinated Windows installer copies source only. It does not apply migration 012, deploy services, install dependencies, start a server or run a local build/dev workflow.
