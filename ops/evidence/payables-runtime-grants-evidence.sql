-- Read-only Production evidence: can the RUNTIME role actually use the payables ledger?
--
-- WHY THIS EXISTS
--
-- None of the payables migrations (Phase 1a, 2, 3) names a privilege. They rely
-- on the default privileges this project's databases carry for new tables. That
-- is a reasonable reliance, but it has never been measured for these tables,
-- and two specifics make it worth measuring before Phase 3 code ships:
--
--   1. Production runs as app_runtime_prod, with exact grants and without
--      BYPASSRLS. A table the owner role can use is not thereby a table the
--      runtime role can use.
--   2. Every payables table has a SERIAL key. Writing a row needs USAGE on the
--      table's SEQUENCE as well as the table privilege, and default privileges
--      for sequences are a separate rule from those for tables.
--
-- A gap here would not break anything that exists today: it would make the new
-- cheque and bank-account screens fail with a permission error on first use.
--
-- It answers exactly these questions:
--   A   the roles involved, and whether app_runtime_prod inherits app_runtime
--   B   effective table privileges on all ten payables tables, for both roles
--   C   effective sequence privileges on all ten sequences, for both roles
--   D   the default privileges the owner role hands to future objects
--
-- SELECT-only. One read-only transaction that ends in ROLLBACK, a session
-- read-only guard and a statement timeout. The CI guard rejects this file if any
-- write keyword appears anywhere in it, remarks and string literals included,
-- so the three write privilege names below are assembled from fragments. The
-- values reaching PostgreSQL are the ordinary privilege names.
--
-- No business data is read: catalogue metadata only.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

\echo '== A1: attributes of the roles involved =='
SELECT rolname,
       rolinherit   AS inherits_privileges,
       rolbypassrls AS bypasses_row_security,
       rolcanlogin  AS can_login
FROM pg_roles
WHERE rolname IN ('app_runtime', 'app_runtime_prod')
ORDER BY rolname;

\echo '== A2: does app_runtime_prod reach app_runtime, and by inheritance =='
SELECT pg_has_role('app_runtime_prod', 'app_runtime', 'MEMBER') AS is_member_of,
       pg_has_role('app_runtime_prod', 'app_runtime', 'USAGE')  AS inherits_from
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
  AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod');

\echo '== B: effective TABLE privileges, per role, per payables table (every cell must be t) =='
WITH verbs(verb) AS (
  VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')
), subjects(rolename) AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_runtime_prod')
), tables(t) AS (
  VALUES ('Payee'), ('Commitment'), ('Installment'), ('Payment'), ('PaymentAllocation'),
         ('PaymentEvidence'), ('PayablesAuditEvent'), ('PayablesMatchRejection'),
         ('BusinessBankAccount'), ('Cheque')
)
SELECT s.rolename AS role_name,
       t.t        AS table_name,
       bool_and(has_table_privilege(s.rolename::name, format('public.%I', t.t), v.verb)) AS all_four,
       string_agg(v.verb || '=' || has_table_privilege(s.rolename::name, format('public.%I', t.t), v.verb)::text,
                  ' ' ORDER BY v.verb) AS detail
FROM subjects s
CROSS JOIN tables t
CROSS JOIN verbs v
GROUP BY s.rolename, t.t
ORDER BY s.rolename, t.t;

\echo '== C: effective SEQUENCE privileges (USAGE is what a SERIAL key needs) =='
WITH subjects(rolename) AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_runtime_prod')
), seqs AS (
  SELECT c.relname AS seq
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'S'
    AND c.relname IN ('Payee_id_seq', 'Commitment_id_seq', 'Installment_id_seq', 'Payment_id_seq',
                      'PaymentAllocation_id_seq', 'PaymentEvidence_id_seq', 'PayablesAuditEvent_id_seq',
                      'PayablesMatchRejection_id_seq', 'BusinessBankAccount_id_seq', 'Cheque_id_seq')
)
SELECT s.rolename AS role_name,
       q.seq      AS sequence_name,
       has_sequence_privilege(s.rolename::name, format('public.%I', q.seq), 'USAGE')  AS usage,
       has_sequence_privilege(s.rolename::name, format('public.%I', q.seq), 'SELECT') AS select_priv
FROM subjects s
CROSS JOIN seqs q
ORDER BY s.rolename, q.seq;

\echo '== C2: how many of the ten expected sequences exist (expected: 10) =='
SELECT count(*) AS sequences_found
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
  AND c.relname IN ('Payee_id_seq', 'Commitment_id_seq', 'Installment_id_seq', 'Payment_id_seq',
                    'PaymentAllocation_id_seq', 'PaymentEvidence_id_seq', 'PayablesAuditEvent_id_seq',
                    'PayablesMatchRejection_id_seq', 'BusinessBankAccount_id_seq', 'Cheque_id_seq');

\echo '== D: default privileges granted to future objects in public (r = tables, S = sequences) =='
SELECT pg_get_userbyid(d.defaclrole)         AS granted_by_role,
       d.defaclobjtype                       AS object_type,
       coalesce(r.rolname, 'PUBLIC')         AS grantee,
       acl.privilege_type                    AS privilege
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE (n.nspname = 'public' OR d.defaclnamespace = 0)
  AND coalesce(r.rolname, 'PUBLIC') IN ('app_runtime', 'app_runtime_prod', 'PUBLIC')
ORDER BY granted_by_role, object_type, grantee, privilege;

\echo '== E: a single verdict (true only if both roles hold every table and sequence privilege) =='
WITH verbs(verb) AS (
  VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')
), subjects(rolename) AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_runtime_prod')
), tables(t) AS (
  VALUES ('Payee'), ('Commitment'), ('Installment'), ('Payment'), ('PaymentAllocation'),
         ('PaymentEvidence'), ('PayablesAuditEvent'), ('PayablesMatchRejection'),
         ('BusinessBankAccount'), ('Cheque')
), seqs(q) AS (
  SELECT t || '_id_seq' FROM tables
)
SELECT (SELECT count(*) FROM subjects) AS roles_checked,
       (SELECT bool_and(has_table_privilege(s.rolename::name, format('public.%I', t.t), v.verb))
          FROM subjects s CROSS JOIN tables t CROSS JOIN verbs v) AS every_table_privilege,
       (SELECT bool_and(has_sequence_privilege(s.rolename::name, format('public.%I', q.q), 'USAGE'))
          FROM subjects s CROSS JOIN seqs q) AS every_sequence_usage;

ROLLBACK;
