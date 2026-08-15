# Technical Analysis — v0.11.1

## Verified runtime blocker

Production preflight for PUT /v1/merchant/customer-experience/draft returned Access-Control-Allow-Methods: GET,HEAD,POST. Browsers therefore rejected the PUT before the route handler was reached. Store Identity, Theme, Typography, Layout, Home Sections, Navigation, Features and Search & Sharing all persist through the same draft PUT and were consequently unable to save.

## Repair

CORS is configured centrally rather than special-casing Customer Experience. This is important because Merchant Admin and Platform Admin also use PATCH/DELETE APIs.

## Media

The previous LOCAL-only storage implementation can lose bytes on an ephemeral production filesystem while database URLs remain. v0.11.1 introduces a storage-provider boundary with LOCAL and R2 implementations. Existing media records continue to use their recorded provider; new uploads use the configured driver.

No secret R2 credentials are exposed to any frontend. R2 access remains server side.
