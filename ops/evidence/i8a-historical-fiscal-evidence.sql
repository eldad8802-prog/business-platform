-- Read-only Production evidence: I-8A historical fiscal persistence.
--
-- WHY THIS EXISTS
--
-- The I-8A migration was proven against an ephemeral PostgreSQL 17 in CI. CI is
-- not Production: the runtime role has a different name, the privilege defaults
-- are set up by hand there, and the guarded block in the migration is skipped
-- entirely if the role it names is absent. So every claim about row-level
-- security, privileges and referential shape has to be measured HERE, on the
-- verified Production endpoint, rather than assumed from the lab.
--
-- It answers exactly these questions and asks nothing else:
--   Q0  which session role is asking, and whether it bypasses row-level security
--   Q1  is the migration recorded as applied, with which checksum
--   Q2  migration ledger totals, unfinished and rolled-back
--   Q3  the table's shape
--   Q4  the table's indexes
--   Q5  the table's constraints, foreign keys included, with referential actions
--   Q6  the composite key on Document
--   Q7  row-level security flags
--   Q8  the policies that exist on the table
--   Q9  which role holds which privilege on the table
--   Q10 the roles the platform runs as
--   Q11 how many historical rows exist
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always ROLLBACKs, with a
-- session read-only guard and a statement timeout. A CI guard rejects this file
-- before it ever reaches the database if it contains a write keyword.
--
-- No business data is read. `_prisma_migrations`, `information_schema` and the
-- `pg_catalog` views hold schema metadata only, and Q11 is a bare count with no
-- projection, so this cannot expose customer or financial records.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q0: who is asking, and is the answer subject to row-level security =='
SELECT current_user                                                        AS session_role,
       (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user)    AS is_superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)    AS bypasses_row_security;

\echo '== Q1: is the I-8A migration recorded as applied =='
SELECT migration_name,
       checksum,
       started_at,
       finished_at,
       applied_steps_count,
       rolled_back_at
FROM _prisma_migrations
WHERE migration_name = '20260907120000_i8a_historical_fiscal_documents';

\echo '== Q2: migration ledger totals (unfinished and rolled back expected zero) =='
SELECT count(*)                                            AS total_applied,
       count(*) FILTER (WHERE finished_at IS NULL)         AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)  AS rolled_back,
       max(migration_name)                                 AS latest_by_name
FROM _prisma_migrations;

\echo '== Q3: HistoricalFiscalDocument shape =='
SELECT ordinal_position,
       column_name,
       data_type,
       numeric_precision,
       numeric_scale,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'HistoricalFiscalDocument'
ORDER BY ordinal_position;

\echo '== Q4: HistoricalFiscalDocument indexes =='
SELECT idx.relname       AS index_name,
       i.indisunique     AS is_unique,
       i.indisprimary    AS is_primary_key,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class tbl ON tbl.oid = i.indrelid
JOIN pg_class idx ON idx.oid = i.indexrelid
WHERE tbl.relname = 'HistoricalFiscalDocument'
ORDER BY idx.relname;

\echo '== Q5: HistoricalFiscalDocument constraints and referential actions =='
SELECT con.conname                          AS constraint_name,
       con.contype                          AS kind,
       ref.relname                          AS references_table,
       pg_get_constraintdef(con.oid)        AS definition
FROM pg_constraint con
LEFT JOIN pg_class ref ON ref.oid = con.confrelid
WHERE con.conrelid = '"HistoricalFiscalDocument"'::regclass
ORDER BY con.contype, con.conname;

\echo '== Q6: the composite key on Document =='
SELECT idx.relname   AS index_name,
       i.indisunique AS is_unique,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class tbl ON tbl.oid = i.indrelid
JOIN pg_class idx ON idx.oid = i.indexrelid
WHERE tbl.relname = 'Document'
  AND idx.relname = 'Document_businessId_id_key';

\echo '== Q7: row-level security flags =='
SELECT relname,
       relrowsecurity      AS row_security_enabled,
       relforcerowsecurity AS row_security_forced
FROM pg_class
WHERE relname = 'HistoricalFiscalDocument';

\echo '== Q8: policies on the table =='
SELECT policyname,
       cmd        AS applies_to,
       permissive,
       roles,
       qual       AS using_expression,
       with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'HistoricalFiscalDocument'
ORDER BY cmd, policyname;

\echo '== Q9: which role holds which privilege on the table =='
SELECT r.rolname          AS role_name,
       acl.privilege_type AS privilege
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
JOIN pg_roles r ON r.oid = acl.grantee
WHERE c.relname = 'HistoricalFiscalDocument'
ORDER BY r.rolname, acl.privilege_type;

\echo '== Q10: the platform roles =='
SELECT rolname,
       rolsuper,
       rolbypassrls,
       rolcanlogin
FROM pg_roles
WHERE rolname LIKE 'app%' OR rolname LIKE 'neondb%'
ORDER BY rolname;

\echo '== Q11: how many historical fiscal rows exist =='
SELECT count(*) AS historical_fiscal_rows
FROM "HistoricalFiscalDocument";

ROLLBACK;
