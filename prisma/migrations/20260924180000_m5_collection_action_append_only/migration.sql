-- M5 · CollectionAction is append-only — make the privilege say so in Production too.
--
-- 20260924090100 granted app_runtime SELECT, INSERT on "CollectionAction" and stated that the grant,
-- not a comment, is what makes the table append-only. Measured on Production after release, through
-- the runtime connection itself (has_table_privilege as app_runtime_prod): UPDATE = true, DELETE = true.
--
-- The same cause ImportRunRow (20260903090000) and HistoricalFiscalDocument already document: this
-- project's databases carry ALTER DEFAULT PRIVILEGES granting app_runtime a,r,w,d on every NEW table,
-- so a table arrives holding privileges nobody asked for, and "not granting" is not "not having".
--
-- It matters more here than there. CollectionAction's tenant policy is FOR ALL, so row-level
-- security permits a same-tenant UPDATE or DELETE — the privilege is the ONLY mechanism between a
-- recorded reminder and its silent revision. The application never issues either (CI asserts it);
-- this makes the database agree rather than trusting that it always will.
--
-- NARROWING ONLY. No table, column, row or policy changes. Nothing the application does is refused:
-- it inserts and reads, and keeps both. Rollback, if ever wanted: GRANT UPDATE, DELETE back.
-- ALTER DEFAULT PRIVILEGES itself is left alone: it governs every future table, and changing it is a
-- separate decision (see 20260908200000).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "CollectionAction" FROM app_runtime;
  END IF;
END
$do$;
