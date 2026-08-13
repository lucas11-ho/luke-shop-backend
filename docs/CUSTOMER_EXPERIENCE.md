# Customer Experience Configuration

Client Admin controls the customer-facing Web/Mobile experience through structured configuration, not arbitrary source code.

Merchant APIs:
- `GET /v1/merchant/customer-experience`
- `PUT /v1/merchant/customer-experience/draft`
- `POST /v1/merchant/customer-experience/publish`
- `POST /v1/merchant/customer-experience/rollback`

Supported configuration includes safe theme tokens, branding, navigation, and allowlisted home sections. The customer storefront receives only the current PUBLISHED configuration through `GET /v1/storefront/config`.

Draft → Preview → Publish is the normal flow. Rollback creates a new published version from a historical published/archived version so history remains auditable.
