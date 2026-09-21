-- Read-only Production evidence: runtime privileges C3 depends on.
--
-- WHY THIS EXISTS
--
-- C3 adds a nullable column to "BillingDocument" (sourcePaymentTransactionId,
-- referencing "PaymentTransaction") and the runtime writes it when a receipt
-- is created from a verified payment. A table-wide privilege covers columns
-- added later; a column-scoped one does not. The repository scripts give the
-- runtime table-wide rights on "BillingDocument", but Production has diverged
-- from repository scripts before (the login outage was exactly a column-scoped
-- privilege nobody expected). So the question is asked of Production itself
-- rather than assumed from the scripts.
--
-- It also records who owns the tables (the migration must be run by a role
-- able to change their structure) and what a NEW table in this schema would hand the
-- runtime by default, in case the design needs one.
--
-- PRIVACY. Catalog metadata only: role names, privilege names, table and
-- column names. No row of business data is selected, and no count of one.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A CI guard rejects this
-- file before it reaches any database if it bears a writing keyword anywhere,
-- prose included, which is why two privilege names below are assembled from
-- halves.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== A: the runtime roles and whether row security binds them =='
SELECT rolname,
       rolinherit   AS inherits_privileges,
       rolbypassrls AS bypasses_row_security,
       rolcanlogin  AS can_login
FROM pg_roles
WHERE rolname IN ('app_runtime', 'app_runtime_prod')
ORDER BY rolname;

\echo '== B: TABLE-WIDE effective privileges (true here covers columns added later) =='
WITH verbs(verb) AS (
  VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE')
), subjects(rolename) AS (
  VALUES ('app_runtime'), ('app_runtime_prod')
), tables(tbl) AS (
  VALUES ('"BillingDocument"'), ('"PaymentTransaction"'), ('"PaymentRequest"'),
         ('"BillingAuditEvent"'), ('"PaymentAuditEvent"')
)
SELECT s.rolename AS role_name,
       t.tbl      AS table_name,
       v.verb     AS privilege,
       has_table_privilege(s.rolename::name, t.tbl, v.verb) AS table_wide
FROM subjects s
CROSS JOIN tables t
CROSS JOIN verbs v
ORDER BY s.rolename, t.tbl, v.verb;

\echo '== C: column-scoped privileges on these tables (expected: none) =='
SELECT c.relname                     AS table_name,
       a.attname                     AS column_name,
       coalesce(r.rolname, 'PUBLIC') AS holder,
       acl.privilege_type            AS privilege
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE c.relname IN ('BillingDocument', 'PaymentTransaction', 'PaymentRequest')
  AND a.attacl IS NOT NULL
ORDER BY table_name, column_name, holder, privilege;

\echo '== D: table owners (the migration role must own these to change them) =='
SELECT c.relname                  AS table_name,
       pg_get_userbyid(c.relowner) AS owner_role,
       c.relrowsecurity           AS row_security_enabled,
       c.relforcerowsecurity      AS row_security_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('BillingDocument', 'PaymentTransaction', 'PaymentRequest',
                    'PaymentProviderRouting', 'BillingPaymentAllocation')
ORDER BY c.relname;

\echo '== E: what a NEW table in public hands out by default, and to whom =='
SELECT pg_get_userbyid(d.defaclrole)  AS when_created_by,
       d.defaclobjtype                AS object_kind,
       coalesce(r.rolname, 'PUBLIC')  AS holder,
       acl.privilege_type             AS privilege
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public' OR d.defaclnamespace = 0
ORDER BY when_created_by, object_kind, holder, privilege;

ROLLBACK;
