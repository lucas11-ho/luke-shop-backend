# Deployment Checklist — Luke Shop Backend v0.1.0

1. Create a new GitHub repository for Luke Shop Backend.
2. Extract the complete source into the repository root.
3. Run `START-HERE-WINDOWS.bat` on a machine with Node 24 and internet access.
4. Review and commit the generated `package-lock.json`.
5. Replace all `.env` example secrets; never commit `.env`.
6. Start a disposable/local PostgreSQL instance.
7. Run `npm run migrate`.
8. Run `npm run bootstrap:tenant -- ...` to create the first Tenant Owner.
9. Start the backend and verify `/health/ready`.
10. Exercise Customer register/login/refresh/logout and Merchant login.
11. Create a Luke CS credential and verify `/v1/customer-service/health` and `/capabilities`.
12. Push to GitHub and require CI to pass, including PostgreSQL tenant-isolation smoke tests and dependency audit.
13. Create a separate Neon/PostgreSQL production project for Shop; do not reuse Luke CS database credentials.
14. Create the Render backend service and configure production environment variables.
15. Set production `CORS_ORIGINS` only to approved Admin/Customer application origins.
16. Run migration 001 exactly once through the migration runner; never edit an applied migration.
17. Take a database snapshot/backup before future migrations.
18. Do not claim production concurrency capacity until load tests are run against the deployed topology.

Current migration: `001_multi_tenant_commerce_foundation.sql`
Next migration: `002`
