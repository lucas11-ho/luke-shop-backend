# Deployment Checklist — Backend v0.6.0

1. Stop the API and back up PostgreSQL.
2. Install the v0.6.0 source upgrade; preserve `.env`, `docker-compose.yml`, and `package-lock.json`.
3. Verify migrations 001-005 match their frozen hashes.
4. Run `npm run migrate` and confirm `006_merchant_staff_rbac_management.sql` applies once.
5. Run `npm run verify`.
6. Run all existing local runtime suites.
7. Run `npm run test:staff-rbac:local`.
8. Start `npm run dev` and verify `/health/ready` reports `0.6.0-merchant-staff-rbac-management`.
9. Upgrade Luke Shop Admin Web to v0.2.0 and test a disposable custom role/staff account.
10. Keep database backups; source rollback does not remove migration 006 automatically.
