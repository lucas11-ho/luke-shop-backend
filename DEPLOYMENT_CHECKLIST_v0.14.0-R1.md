# Deployment Checklist — Luke Shop Backend v0.14.0-R1

## Before deployment

- [ ] Confirm backend source is v0.14.0 and Git has no unmerged entries.
- [ ] Snapshot the Luke Shop production Neon database.
- [ ] Confirm migrations 001–015 are already recorded in `schema_migrations`.
- [ ] Confirm `ASSET_STORAGE_DRIVER=R2` and R2 credentials remain configured on Render.
- [ ] Keep `R2_PUBLIC_BASE_URL` blank for private-bucket/backend-proxy mode.

## Apply database repair

Run the normal backend migration command so migration 016 is applied. Do not edit migration 009.

Verify the active constraint with:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'media_assets'::regclass
  AND contype = 'c';
```

Expected storage-provider rule includes both `LOCAL` and `R2`.

## Runtime acceptance

- [ ] Upload a new PNG/JPG from Merchant Admin Media Library.
- [ ] Verify API returns 201, not 500.
- [ ] Verify the new asset appears in Media Library.
- [ ] Verify the corresponding object exists in the R2 bucket.
- [ ] Open the public backend-proxy asset URL and confirm it renders.
- [ ] Upload a customer profile avatar.
- [ ] Refresh Profile and confirm the avatar persists.
- [ ] Restart/redeploy backend and recheck both images.

## Cleanup

After new uploads are confirmed, remove known orphan R2 objects from earlier failed requests if they have no corresponding `media_assets` record.
