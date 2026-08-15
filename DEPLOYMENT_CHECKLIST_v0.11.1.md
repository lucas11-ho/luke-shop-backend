# Deployment Checklist — Backend v0.11.1

1. Confirm Neon migration 012 is already applied. v0.11.1 has no new migration.
2. Confirm CORS_ORIGINS contains the exact production Merchant Admin, Customer Web and Platform Admin origins needed by browser calls.
3. Configure production media storage:
   - ASSET_STORAGE_DRIVER=R2
   - R2_ACCOUNT_ID
   - R2_BUCKET
   - R2_ACCESS_KEY_ID
   - R2_SECRET_ACCESS_KEY
   - optional R2_PUBLIC_BASE_URL
4. Deploy Backend v0.11.1.
5. Run the real production OPTIONS acceptance check for PUT /v1/merchant/customer-experience/draft. Verify Access-Control-Allow-Methods contains PUT, PATCH and DELETE.
6. Deploy Customer Web v0.6.1 and Merchant Admin v0.9.1.
7. Test Store Identity -> save -> refresh -> preview -> publish -> live Customer Web.
8. Test Template, Theme, Typography, Layout, Home Sections, Navigation, Features and Search & Sharing individually.
9. Re-upload/reselect any media that returns ASSET_NOT_FOUND or ASSET_CONTENT_NOT_FOUND because lost LOCAL bytes cannot be reconstructed.
10. Do not treat source-regression PASS as deployed-runtime PASS.
