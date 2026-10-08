-- Least-privilege database roles (spec 18: "separate service accounts for database, storage, media worker and admin").
-- Run once as the Postgres superuser AFTER the first migration, then point each service at its own role:
--   migrator  : DDL only, used by the deployment step `node dist/scripts/migrate.js up`
--   api       : DML for the API process
--   worker    : DML for workers (same table access as api; separate credentials let you revoke/rotate independently)
--   readonly  : reporting/support tooling (no PII columns beyond what the app already masks)
-- The application roles can NOT alter the schema, truncate tables, or change/delete audit events even if the trigger were dropped.
-- Replace the placeholder passwords with secrets from the Ethiopia-hosted secret store.

CREATE ROLE event_migrator LOGIN PASSWORD 'REPLACE_ME_migrator' NOINHERIT;
CREATE ROLE event_api      LOGIN PASSWORD 'REPLACE_ME_api'      NOINHERIT;
CREATE ROLE event_worker   LOGIN PASSWORD 'REPLACE_ME_worker'   NOINHERIT;
CREATE ROLE event_readonly LOGIN PASSWORD 'REPLACE_ME_readonly' NOINHERIT;

GRANT CONNECT ON DATABASE event TO event_migrator, event_api, event_worker, event_readonly;
GRANT USAGE ON SCHEMA public TO event_migrator, event_api, event_worker, event_readonly;
GRANT CREATE ON SCHEMA public TO event_migrator;

-- migrator owns/creates objects (run migrations as this role; transfer ownership of existing tables if you started as superuser)
-- REASSIGN OWNED BY <initial_owner> TO event_migrator;

-- application roles: data access only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO event_api, event_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO event_api, event_worker;

-- audit log: append-only for everyone except nobody - no UPDATE/DELETE/TRUNCATE privileges at all
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM event_api, event_worker;
-- schema_migrations is migrator-only
REVOKE ALL ON schema_migrations FROM event_api, event_worker, event_readonly;

-- sandbox payment table must not exist in production (it is only created by migration 001 for dev/test); keep it unreachable
REVOKE ALL ON sandbox_transactions FROM event_api, event_worker;

-- read-only role: no secrets, no auth material, no raw personal data
GRANT SELECT ON events, plans, entitlements, payment_orders, invoices, reconciliation_runs, deletion_jobs, incidents, vendors, backup_runs, storage_scans, analytics_counters TO event_readonly;

-- future tables created by the migrator get the same defaults
ALTER DEFAULT PRIVILEGES FOR ROLE event_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO event_api, event_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE event_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO event_api, event_worker;
