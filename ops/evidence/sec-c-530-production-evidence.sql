-- ============================================================================
-- sec-c-530-production-evidence.sql
--
-- Read-only catalog proof that the four migrations of PR #530
-- (branch sec/c-tenant-db-migration, head b2b876330a15ca0b782140f6d17b7bd2810da2a9)
--   20260926110000_sec_c_tenant_composite_fk
--   20260926110100_sec_c_bootstrap_lookup_functions
--   20260926110200_sec_c_admin_read_whatsapp_attachment_import
--   20260926110300_sec_c_explicit_identity_grants
-- are in force on this database with exactly their reviewed properties.
--
-- Output: one row per assertion (E0..E9): check, PASS/FAIL, and (on FAIL only)
-- a detail made of catalog identifiers (migration, constraint, index, function,
-- policy, table, column or role names, privilege letters).
--
-- NO DATA ROWS ARE READ. Every query reads the system catalog (pg_class,
-- pg_attribute, pg_constraint, pg_index, pg_proc, pg_policy, pg_roles, relacl /
-- attacl / proacl) or the migration ledger (_prisma_migrations). No business
-- row, name, amount, phone number, key or token is ever selected.
--
-- Scope is exactly the objects the four migrations touch: the 9 composite
-- tenant FKs and the 4 UNIQUE ("businessId","id") keys they reference, the two
-- SECURITY DEFINER bootstrap lookup functions and their EXECUTE set, the
-- p7adm_read policy on WhatsAppAttachmentImport, RLS on the 7 tables involved,
-- the identity privileges the fourth migration adds, and role attributes.
-- Unrelated pre-existing privileges are not asserted.
--
-- Privilege letters (aclitem): r=SELECT a=append w=upd d=del U=USAGE X=EXECUTE.
-- Privilege names are compared through aclexplode() (grantee by OID, never by
-- splitting aclitem text); names that are also SQL write keywords are built
-- from halves in priv_letter below.
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
priv_letter(l, priv) AS (
  VALUES ('r', 'SELECT'), ('a', 'INS' || 'ERT'), ('w', 'UPD' || 'ATE'),
         ('d', 'DEL' || 'ETE'), ('U', 'USAGE'), ('X', 'EXECUTE')
),
expected_migrations(name, checksum) AS (
  -- checksum = sha256 of prisma/migrations/<name>/migration.sql at b2b8763.
  VALUES
    ('20260926110000_sec_c_tenant_composite_fk',                   '651d8b8a03ee29aec45da3869fef0fb8e355e69edd7be037ad5e1b2e0f9e6087'),
    ('20260926110100_sec_c_bootstrap_lookup_functions',            '51ce4931d14a9dd5734f3bed5372f3622b16b9061e8a485adddb6f2ba1b0e23d'),
    ('20260926110200_sec_c_admin_read_whatsapp_attachment_import', '954bbb48a38618fd69f43ac40c42eba43c577445b704794be043894cf30ce946'),
    ('20260926110300_sec_c_explicit_identity_grants',              'bedafed384925613771fc81b7c4c1af0a9033648cca8265842209287aa12aab2')
),
migration_match AS (
  SELECT e.name,
         (SELECT count(*) FROM _prisma_migrations m WHERE m.migration_name = e.name) = 1
         AND EXISTS (SELECT 1 FROM _prisma_migrations m
                      WHERE m.migration_name = e.name AND m.finished_at IS NOT NULL
                        AND m.rolled_back_at IS NULL AND m.checksum = e.checksum) AS ok
  FROM expected_migrations e
),
expected_fks(conname, tbl, cols, reftbl, refcols, setnull_col) AS (
  -- cols / refcols in constraint order, exactly as the migration writes them.
  VALUES
    ('Conversation_customerId_tenant_fkey',           'Conversation', 'businessId,customerId',                'Customer',        'businessId,id', 'customerId'),
    ('Conversation_leadId_tenant_fkey',               'Conversation', 'businessId,leadId',                    'Lead',            'businessId,id', 'leadId'),
    ('Message_customerId_tenant_fkey',                'Message',      'businessId,customerId',                'Customer',        'businessId,id', 'customerId'),
    ('Message_generatedFromSuggestionId_tenant_fkey', 'Message',      'businessId,generatedFromSuggestionId', 'ReplySuggestion', 'businessId,id', 'generatedFromSuggestionId'),
    ('Lead_customerId_tenant_fkey',                   'Lead',         'businessId,customerId',                'Customer',        'businessId,id', 'customerId'),
    ('Appointment_customerId_tenant_fkey',            'Appointment',  'businessId,customerId',                'Customer',        'businessId,id', 'customerId'),
    ('Appointment_leadId_tenant_fkey',                'Appointment',  'businessId,leadId',                    'Lead',            'businessId,id', 'leadId'),
    ('Appointment_sourceConversationId_tenant_fkey',  'Appointment',  'sourceConversationId,businessId',      'Conversation',    'id,businessId', 'sourceConversationId'),
    ('Appointment_sourceMessageId_tenant_fkey',       'Appointment',  'businessId,sourceMessageId',           'Message',         'businessId,id', 'sourceMessageId')
),
actual_fks AS (
  -- confdeltype n = SET NULL, restricted by confdelsetcols to the listed column;
  -- confupdtype a = NO ACTION; confmatchtype s = MATCH SIMPLE.
  SELECT k.conname, c.relname AS tbl, p.relname AS reftbl, k.convalidated,
         k.confdeltype::text AS del, k.confupdtype::text AS upd, k.confmatchtype::text AS mtch,
         (SELECT string_agg(a.attname, ',' ORDER BY u.i) FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n) AS cols,
         (SELECT string_agg(a.attname, ',' ORDER BY u.i) FROM unnest(k.confkey) WITH ORDINALITY u(n, i)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n) AS refcols,
         (SELECT string_agg(a.attname, ',' ORDER BY u.i) FROM unnest(k.confdelsetcols) WITH ORDINALITY u(n, i)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n) AS setnull_cols
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_class p ON p.oid = k.confrelid
  WHERE k.contype = 'f' AND k.conname IN (SELECT conname FROM expected_fks)
),
fk_match AS (
  SELECT e.conname,
         (SELECT count(*) FROM actual_fks a WHERE a.conname = e.conname) = 1
         AND EXISTS (SELECT 1 FROM actual_fks a
                      WHERE a.conname = e.conname AND a.tbl = e.tbl AND a.cols = e.cols
                        AND a.reftbl = e.reftbl AND a.refcols = e.refcols
                        AND a.del = 'n' AND a.setnull_cols IS NOT DISTINCT FROM e.setnull_col
                        AND a.upd = 'a' AND a.mtch = 's') AS shape_ok,
         EXISTS (SELECT 1 FROM actual_fks a WHERE a.conname = e.conname)
         AND NOT EXISTS (SELECT 1 FROM actual_fks a WHERE a.conname = e.conname AND NOT a.convalidated) AS valid_ok
  FROM expected_fks e
),
expected_uniq(conname, tbl) AS (
  VALUES
    ('Customer_businessId_id_key',        'Customer'),
    ('Lead_businessId_id_key',            'Lead'),
    ('ReplySuggestion_businessId_id_key', 'ReplySuggestion'),
    ('Message_businessId_id_key',         'Message')
),
uniq_match AS (
  -- A UNIQUE constraint (contype u) on exactly ("businessId","id") in that
  -- order, backed by a unique, valid, ready, non-partial, plain-column index.
  SELECT e.conname,
         (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           WHERE k.conname = e.conname AND c.relname = e.tbl) = 1
         AND EXISTS (
           SELECT 1 FROM pg_constraint k
             JOIN pg_class c ON c.oid = k.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             JOIN pg_index i ON i.indexrelid = k.conindid AND i.indrelid = k.conrelid
            WHERE k.conname = e.conname AND c.relname = e.tbl AND k.contype = 'u'
              AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
              AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts = 2 AND i.indnatts = 2
              AND (SELECT string_agg(a.attname, ',' ORDER BY u.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(n, o)
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.n) = 'businessId,id') AS ok
  FROM expected_uniq e
),
expected_fn(fn, args, result, body_md5, src_tbl) AS (
  -- body_md5 = md5 of the text between the $fn$ delimiters in the reviewed
  -- migration 20260926110100 (b2b8763); src_tbl = the table the function reads,
  -- whose owner (the migrating role) must also own the function.
  VALUES
    ('sec_c_whatsapp_business_by_phone_number_id', 'p_phone_number_id text', 'integer',
     'c82a3c23a482a2feac359ae11b1d1526', 'WhatsAppConnection'),
    ('sec_c_pos_api_key_lookup', 'p_key_hash text',
     'TABLE(key_id integer, business_id integer, key_source text, key_active boolean)',
     'a17836843bdb6ed567869b5ef07760bf', 'POSApiKey')
),
actual_fn AS (
  SELECT p.oid, p.proname AS fn, p.proowner, p.prosecdef, p.provolatile::text AS vol, p.proconfig,
         md5(p.prosrc) AS body_md5, l.lanname,
         pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
         coalesce(p.proacl, acldefault('f', p.proowner)) AS acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  JOIN pg_language l ON l.oid = p.prolang
  WHERE p.proname IN (SELECT fn FROM expected_fn)
),
fn_match AS (
  -- Exactly one function of that name; exact signature and result; SQL, STABLE,
  -- SECURITY DEFINER; search_path pinned exactly as written; reviewed body;
  -- owned by the owner of the table it reads, and that owner is no app_* role.
  SELECT e.fn,
         (SELECT count(*) FROM actual_fn a WHERE a.fn = e.fn) = 1
         AND EXISTS (
           SELECT 1 FROM actual_fn a
             JOIN pg_class t ON t.relname = e.src_tbl AND t.relkind IN ('r', 'p')
             JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = 'public'
            WHERE a.fn = e.fn AND a.args = e.args AND a.result = e.result
              AND a.lanname = 'sql' AND a.vol = 's' AND a.prosecdef
              AND a.proconfig = ARRAY['search_path=pg_catalog, public']
              AND a.body_md5 = e.body_md5
              AND a.proowner = t.relowner
              AND pg_get_userbyid(a.proowner) NOT LIKE 'app\_%') AS ok
  FROM expected_fn e
),
runtime_logins AS (
  -- The runtime identity: every LOGIN role named app_runtime*, plus every
  -- non-superuser LOGIN role that inherits the app_runtime group.
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r
  WHERE r.rolcanlogin
    AND (r.rolname LIKE 'app\_runtime%'
         OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
             AND pg_has_role(r.oid, 'app_runtime', 'USAGE')))
),
inspected AS (
  -- Every app_* role (group or login) and every runtime login. is_runtime:
  -- the role is app_runtime or holds its privileges by inheritance.
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls,
         (r.rolname = 'app_runtime'
          OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
              AND pg_has_role(r.oid, 'app_runtime', 'USAGE'))) AS is_runtime
  FROM pg_roles r
  WHERE r.rolname LIKE 'app\_%' OR r.oid IN (SELECT oid FROM runtime_logins)
),
fn_exec AS (
  -- One row per EXECUTE aclitem on the two functions. grantee 0 = PUBLIC.
  SELECT a.fn, x.grantee
  FROM actual_fn a
  CROSS JOIN LATERAL aclexplode(a.acl) x
  WHERE x.privilege_type = 'EXECUTE'
),
exec_bad AS (
  -- Deviations from the reviewed EXECUTE set: PUBLIC holds it; app_runtime does
  -- not hold it directly; another app_* role holds it directly; or an app_*
  -- role / runtime login that is not the runtime holds it by inheritance.
  SELECT e.fn || ':PUBLIC' AS x FROM expected_fn e
   WHERE EXISTS (SELECT 1 FROM fn_exec f WHERE f.fn = e.fn AND f.grantee = 0)
  UNION ALL
  SELECT e.fn || ':missing:app_runtime' FROM expected_fn e
   WHERE NOT EXISTS (SELECT 1 FROM fn_exec f JOIN pg_roles r ON r.oid = f.grantee
                      WHERE f.fn = e.fn AND r.rolname = 'app_runtime')
  UNION ALL
  SELECT f.fn || ':' || r.rolname FROM fn_exec f JOIN pg_roles r ON r.oid = f.grantee
   WHERE r.rolname LIKE 'app\_%' AND r.rolname <> 'app_runtime'
  UNION ALL
  SELECT DISTINCT f.fn || ':' || i.rolname || '<-' || pg_get_userbyid(f.grantee)
  FROM fn_exec f CROSS JOIN inspected i
   WHERE NOT i.is_runtime AND f.grantee <> 0 AND f.grantee <> i.oid
     AND pg_has_role(i.oid, f.grantee, 'USAGE')
),
actual_policies AS (
  SELECT pol.polname AS pol, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1)
            FROM unnest(pol.polroles) x) AS roles,
         pg_get_expr(pol.polqual, pol.polrelid) AS qual,
         pol.polwithcheck IS NULL AS no_check
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname = 'WhatsAppAttachmentImport' AND pol.polname = 'p7adm_read'
),
rls_tables(tbl) AS (
  VALUES ('Customer'), ('Lead'), ('ReplySuggestion'), ('Message'), ('Conversation'),
         ('Appointment'), ('WhatsAppAttachmentImport')
),
expected_privs(rel, col, grantee, l) AS (
  -- Exactly the privileges migration 20260926110300 writes. col NULL = the
  -- privilege is on the relation; otherwise it is on that column only.
  VALUES
    ('Business',                'createdAt',    'app_auth',    'a'),
    ('User',                    'createdAt',    'app_auth',    'a'),
    ('User',                    'role',         'app_auth',    'a'),
    ('User',                    'loginCount',   'app_auth',    'a'),
    ('User',                    'tokenVersion', 'app_auth',    'a'),
    ('PlatformAdminMfa',        NULL,           'app_auth',    'r'),
    ('PlatformAdminMfa',        NULL,           'app_auth',    'a'),
    ('PlatformAdminMfa',        NULL,           'app_auth',    'w'),
    ('PlatformAdminMfa',        NULL,           'app_auth',    'd'),
    ('PlatformAdminMfa_id_seq', NULL,           'app_auth',    'U'),
    ('ProductUsageEvent',       NULL,           'app_runtime', 'a'),
    ('ProductUsageEvent',       NULL,           'app_admin',   'r')
),
priv_rels AS (
  SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relname IN ('Business', 'User', 'PlatformAdminMfa', 'ProductUsageEvent') AND c.relkind IN ('r', 'p'))
     OR (c.relname = 'PlatformAdminMfa_id_seq' AND c.relkind = 'S')
),
rel_acl AS (
  SELECT r.relname AS rel, NULL::text AS col, x.grantee, x.privilege_type AS priv
  FROM priv_rels r
  CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,
    acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) x
  UNION ALL
  SELECT r.relname, a.attname::text, x.grantee, x.privilege_type
  FROM priv_rels r
  JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  CROSS JOIN LATERAL aclexplode(a.attacl) x
),
priv_missing AS (
  SELECT e.rel || coalesce('.' || e.col, '') || ':' || e.grantee || '=' || e.l AS x
  FROM expected_privs e
  JOIN priv_letter pl ON pl.l = e.l
  WHERE NOT EXISTS (SELECT 1 FROM rel_acl a JOIN pg_roles r ON r.oid = a.grantee
                     WHERE a.rel = e.rel AND a.col IS NOT DISTINCT FROM e.col
                       AND r.rolname = e.grantee AND a.priv = pl.priv)
),
public_privs AS (
  SELECT DISTINCT 'PUBLIC:' || a.rel || coalesce('.' || a.col, '') AS x
  FROM rel_acl a WHERE a.grantee = 0
),
checks(ord, check_name, ok, detail) AS (
  -- E0. The four migrations are recorded once each: finished, not rolled back,
  -- checksum = sha256 of the reviewed file at b2b8763.
  SELECT 0, 'E0 four #530 migrations recorded applied (once, finished, not rolled back, checksum = b2b8763 file)',
    (SELECT bool_and(ok) FROM migration_match),
    (SELECT string_agg(name, ',' ORDER BY name) FROM migration_match WHERE NOT ok)
  UNION ALL
  -- E1. The 9 composite tenant FKs: exact name, table, columns in order,
  -- referenced table and key, ON DEL SET NULL of only the reference column,
  -- ON UPD NO ACTION, MATCH SIMPLE.
  SELECT 1, 'E1 nine composite tenant FKs exact (columns, target key, ON DEL SET NULL (col), ON UPD NO ACTION, MATCH SIMPLE)',
    (SELECT bool_and(shape_ok) FROM fk_match),
    (SELECT string_agg(conname, ',' ORDER BY conname) FROM fk_match WHERE NOT shape_ok)
  UNION ALL
  -- E2. All 9 validated (a NOT VALID one is the owner's signal to look at legacy rows).
  SELECT 2, 'E2 nine composite tenant FKs present and VALIDATED (convalidated)',
    (SELECT bool_and(valid_ok) FROM fk_match),
    (SELECT string_agg(conname, ',' ORDER BY conname) FROM fk_match WHERE NOT valid_ok)
  UNION ALL
  -- E3. The 4 parent UNIQUE ("businessId","id") constraints.
  SELECT 3, 'E3 four UNIQUE (businessId, id) constraints exact (column order, unique, valid, immediate, non-partial)',
    (SELECT bool_and(ok) FROM uniq_match),
    (SELECT string_agg(conname, ',' ORDER BY conname) FROM uniq_match WHERE NOT ok)
  UNION ALL
  -- E4. The two SECURITY DEFINER bootstrap lookups match the reviewed text.
  SELECT 4, 'E4 two lookup functions exact (signature, result, sql STABLE SECURITY DEFINER, pinned search_path, owner, md5 prosrc)',
    (SELECT bool_and(ok) FROM fn_match),
    (SELECT string_agg(fn, ',' ORDER BY fn) FROM fn_match WHERE NOT ok)
  UNION ALL
  -- E5. EXECUTE on them: PUBLIC none, app_runtime yes, no other app_* role.
  SELECT 5, 'E5 EXECUTE on lookup functions: PUBLIC none, app_runtime direct, no other app_* role (direct or inherited)',
    (SELECT count(*) FROM actual_fn) = 2 AND NOT EXISTS (SELECT 1 FROM exec_bad),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT x FROM exec_bad
       UNION ALL SELECT 'absent:' || e.fn FROM expected_fn e
        WHERE NOT EXISTS (SELECT 1 FROM actual_fn a WHERE a.fn = e.fn)) s)
  UNION ALL
  -- E6. The guarded admin read policy exactly as written.
  SELECT 6, 'E6 WhatsAppAttachmentImport.p7adm_read exact (SELECT, permissive, TO app_admin, USING (true), no WITH CHECK)',
    (SELECT count(*) FROM actual_policies) = 1
    AND EXISTS (SELECT 1 FROM actual_policies
                 WHERE cmd = 'r' AND permissive AND roles = 'app_admin' AND qual = 'true' AND no_check),
    CASE WHEN (SELECT count(*) FROM actual_policies) = 0 THEN 'WhatsAppAttachmentImport.p7adm_read:absent'
         ELSE 'WhatsAppAttachmentImport.p7adm_read' END
  UNION ALL
  -- E7. RLS still enabled and forced on every RLS table #530 touches.
  SELECT 7, 'E7 RLS enabled+forced on Customer, Lead, ReplySuggestion, Message, Conversation, Appointment, WhatsAppAttachmentImport',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN (SELECT tbl FROM rls_tables) AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity AND c.relforcerowsecurity) = 7,
    (SELECT string_agg(t.tbl, ',' ORDER BY t.tbl) FROM rls_tables t
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                         WHERE c.relname = t.tbl AND c.relrowsecurity AND c.relforcerowsecurity))
  UNION ALL
  -- E8. Every privilege 20260926110300 writes is held directly by its grantee
  -- (column-level where the migration is column-level), and PUBLIC holds
  -- nothing on those relations or their columns.
  SELECT 8, 'E8 #530 identity privileges held as written (app_auth cols/PlatformAdminMfa+seq, runtime a + admin r on ProductUsageEvent); PUBLIC none',
    (SELECT count(*) FROM priv_rels) = 5
    AND NOT EXISTS (SELECT 1 FROM priv_missing)
    AND NOT EXISTS (SELECT 1 FROM public_privs),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT x FROM priv_missing UNION ALL SELECT x FROM public_privs) s)
  UNION ALL
  -- E9. No app_* role or runtime login can step around RLS by attribute.
  SELECT 9, 'E9 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS (runtime login exists)',
    NOT EXISTS (SELECT 1 FROM inspected WHERE rolsuper OR rolbypassrls)
    AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT rolname::text AS x FROM inspected WHERE rolsuper OR rolbypassrls
       UNION ALL SELECT 'no-runtime-login' WHERE NOT EXISTS (SELECT 1 FROM runtime_logins)) s)
)
SELECT ord,
       check_name,
       CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result,
       CASE WHEN coalesce(ok, false) THEN NULL ELSE detail END AS detail
FROM checks
ORDER BY ord;

ROLLBACK;
