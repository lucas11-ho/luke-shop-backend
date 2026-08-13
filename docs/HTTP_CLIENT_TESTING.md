# HTTP Client Testing — Luke Shop Backend v0.1.2

## Recommended PowerShell JSON request

```powershell
$body = @{ email = "owner@example.com"; password = "YOUR_PASSWORD" } | ConvertTo-Json
$login = Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:4100/v1/merchant/auth/login" `
  -Headers @{ "x-tenant-slug" = "demo" } `
  -ContentType "application/json" `
  -Body $body
```

## Logout with Invoke-RestMethod

For a bodyless JSON API POST, explicitly send JSON to avoid Windows PowerShell's form-style POST defaults:

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:4100/v1/merchant/auth/logout" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body "{}"
```

## Logout with curl.exe

```powershell
curl.exe -i -X POST "http://localhost:4100/v1/merchant/auth/logout" -H "Authorization: Bearer $token"
```

A successful first logout returns `200` and `logged_out: true`. Reusing that access token should return `401 SESSION_INVALID`.

## Expected malformed request behavior

- unsupported `Content-Type` -> `415 UNSUPPORTED_MEDIA_TYPE`
- malformed JSON -> `400 INVALID_JSON`
- missing/invalid auth -> `401`
- missing route -> `404 ROUTE_NOT_FOUND`
- rate limit exceeded -> `429 RATE_LIMITED`

Do not paste production access tokens, refresh tokens, service credentials or database URLs into bug reports.
