# Luke Shop Backend v0.11.0 — Operations & Control Completion

This release closes operational control gaps found by auditing all backend routes against Merchant Admin, Customer Web and Platform Admin.

## Added

- Merchant tenant store list/create/update and audited store-management permission.
- Merchant self profile, password and session controls.
- Customer profile, saved-address, password and session controls.
- Inventory-location update controls.
- Category update and modifier group/option edit/deactivate operations.
- Promotion code edit/deactivate and target removal.
- Payment method public provider configuration and ordering.
- Audited full-remaining refund records and controlled status lifecycle.
- Richer merchant customer detail with addresses, status history, orders and sessions.
- Platform plan create/update and typography preset create/update.
- Platform tenant store controls, regional settings, internal notes and owner account controls.
- Platform Owner self profile/password/session controls.
- Real DNS TXT challenge verification for custom domains.
- Migration `012_operations_control_completion.sql`.

## Safety boundaries

Refund status changes record Luke's internal/audited workflow and do not execute provider-side money movement. Customer forgot-password delivery is not fabricated without an external reset-token delivery provider.
