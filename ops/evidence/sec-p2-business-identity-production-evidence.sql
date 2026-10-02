-- ============================================================================
-- sec-p2-business-identity-production-evidence.sql
--
-- Read-only catalog proof that migration
--   20261004090000_p2_business_identity
-- is in force on this database with exactly its intended security properties.
--
-- Output: one row per assertion: check, PASS/FAIL, and (on FAIL only) a detail
-- made of catalog identifiers (table, column, constraint, index, policy, type
-- or role names, privilege letters).
--
-- NO DATA ROWS ARE READ. Every query reads the system catalog (pg_class,
-- pg_attribute, pg_attrdef, pg_constraint, pg_index, pg_policy, pg_type,
-- pg_enum, pg_trigger, pg_roles, relacl) or the migration ledger
-- (_prisma_migrations). No business row, statement text, value hash, name or
-- key is selected.
--
-- Scope: the two new tables BusinessIdentityStatement and
-- BusinessIdentityFactAuthority (columns, FKs, CHECK constraints, plain and
-- PARTIAL unique indexes with their exact predicates, RLS, the exact
-- per-command policy set, effective privileges on the tables and their id
-- sequences) and the four enum types. The migration defines no function and no
-- trigger; Q12 proves none is attached.
--
-- Privilege letters (aclitem): r=read a=append w=upd d=del D=trunc x=refs
-- t=trigger m=maintain U=usage. Grantee names are resolved through
-- aclexplode() (OIDs). Privilege checks are EFFECTIVE: a privilege reached
-- through role membership (INHERIT) or PUBLIC counts, and every role whose
-- name starts with app_ is inspected, plus every non-superuser LOGIN role that
-- inherits app_runtime. Same method as the P1 offering evidence file.
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
new_tables(tbl) AS (
  VALUES ('BusinessIdentityStatement'), ('BusinessIdentityFactAuthority')
),
tenant_expr(e) AS (
  VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')
),
expected_enums(typ, labels) AS (
  VALUES
    ('BusinessIdentityDimension', 'DESCRIPTION,SPECIALIZATION,TARGET_AUDIENCE,PRIMARY_OBJECTIVE,SECONDARY_OBJECTIVE,TONE,POSITIONING,DIFFERENTIATOR,SERVICE_AREA'),
    ('BusinessIdentitySource',    'OWNER_INPUT,OWNER_ADOPTED_SUGGESTION'),
    ('BusinessIdentityStatus',    'ACTIVE,RETIRED'),
    ('BusinessIdentityFact',      'BUSINESS_NAME,CITY,OPENING_HOURS,PUBLIC_PHONE,PUBLIC_EMAIL,PUBLIC_ADDRESS')
),
actual_enums AS (
  SELECT t.typname AS typ, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typtype = 'e' AND t.typname IN (SELECT typ FROM expected_enums)
  GROUP BY t.typname
),
expected_cols(tbl, col, typ, nn, def) AS (
  VALUES
    ('BusinessIdentityStatement', 'id',                        'integer',                        true,  'serial'),
    ('BusinessIdentityStatement', 'businessId',                'integer',                        true,  NULL),
    ('BusinessIdentityStatement', 'dimension',                 '"BusinessIdentityDimension"',    true,  NULL),
    ('BusinessIdentityStatement', 'code',                      'text',                           false, NULL),
    ('BusinessIdentityStatement', 'text',                      'text',                           false, NULL),
    ('BusinessIdentityStatement', 'source',                    '"BusinessIdentitySource"',       true,  NULL),
    ('BusinessIdentityStatement', 'sourceRef',                 'text',                           false, NULL),
    ('BusinessIdentityStatement', 'status',                    '"BusinessIdentityStatus"',       true,  '''ACTIVE''::"BusinessIdentityStatus"'),
    ('BusinessIdentityStatement', 'confirmedByUserId',         'integer',                        false, NULL),
    ('BusinessIdentityStatement', 'publicUseApproved',         'boolean',                        true,  'false'),
    ('BusinessIdentityStatement', 'publicUseApprovedAt',       'timestamp(3) without time zone', false, NULL),
    ('BusinessIdentityStatement', 'publicUseApprovedByUserId', 'integer',                        false, NULL),
    ('BusinessIdentityStatement', 'retiredAt',                 'timestamp(3) without time zone', false, NULL),
    ('BusinessIdentityStatement', 'retiredByUserId',           'integer',                        false, NULL),
    ('BusinessIdentityStatement', 'createdAt',                 'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('BusinessIdentityStatement', 'updatedAt',                 'timestamp(3) without time zone', true,  NULL),
    ('BusinessIdentityFactAuthority', 'id',                        'integer',                        true,  'serial'),
    ('BusinessIdentityFactAuthority', 'businessId',                'integer',                        true,  NULL),
    ('BusinessIdentityFactAuthority', 'fact',                      '"BusinessIdentityFact"',         true,  NULL),
    ('BusinessIdentityFactAuthority', 'sourceField',               'text',                           true,  NULL),
    ('BusinessIdentityFactAuthority', 'valueHash',                 'text',                           true,  NULL),
    ('BusinessIdentityFactAuthority', 'status',                    '"BusinessIdentityStatus"',       true,  '''ACTIVE''::"BusinessIdentityStatus"'),
    ('BusinessIdentityFactAuthority', 'confirmedByUserId',         'integer',                        false, NULL),
    ('BusinessIdentityFactAuthority', 'confirmedAt',               'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('BusinessIdentityFactAuthority', 'publicUseApproved',         'boolean',                        true,  'false'),
    ('BusinessIdentityFactAuthority', 'publicUseApprovedAt',       'timestamp(3) without time zone', false, NULL),
    ('BusinessIdentityFactAuthority', 'publicUseApprovedByUserId', 'integer',                        false, NULL),
    ('BusinessIdentityFactAuthority', 'retiredAt',                 'timestamp(3) without time zone', false, NULL),
    ('BusinessIdentityFactAuthority', 'retiredByUserId',           'integer',                        false, NULL),
    ('BusinessIdentityFactAuthority', 'createdAt',                 'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('BusinessIdentityFactAuthority', 'updatedAt',                 'timestamp(3) without time zone', true,  NULL)
),
actual_cols AS (
  SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def,
         pg_get_serial_sequence(format('%I', c.relname), a.attname) AS serial_seq
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname IN (SELECT tbl FROM new_tables)
),
col_match AS (
  SELECT e.tbl, e.col,
         EXISTS (SELECT 1 FROM actual_cols a
                  WHERE a.tbl = e.tbl AND a.col = e.col AND a.typ = e.typ AND a.nn = e.nn
                    AND CASE
                          WHEN e.def IS NULL THEN a.def IS NULL
                          WHEN e.def = 'serial' THEN a.serial_seq = format('public.%I', e.tbl || '_id_seq')
                                                    AND position(format('%I', e.tbl || '_id_seq') IN coalesce(a.def, '')) > 0
                          ELSE a.def = e.def
                        END) AS ok
  FROM expected_cols e
),
actual_fks AS (
  SELECT c.relname AS tbl, k.conname,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols,
         p.relname AS reftbl, k.confdeltype::text AS del, k.confupdtype::text AS upd, k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_class p ON p.oid = k.confrelid
  WHERE k.contype = 'f' AND c.relname IN (SELECT tbl FROM new_tables)
),
expected_checks(tbl, conname, cols) AS (
  -- cols: the columns the CHECK reads, sorted (C collation).
  VALUES
    ('BusinessIdentityStatement',     'BusinessIdentityStatement_value_shape',       'code,dimension,text'),
    ('BusinessIdentityStatement',     'BusinessIdentityStatement_public_use',        'dimension,publicUseApproved,publicUseApprovedAt'),
    ('BusinessIdentityStatement',     'BusinessIdentityStatement_retired_shape',     'retiredAt,status'),
    ('BusinessIdentityStatement',     'BusinessIdentityStatement_provenance',        'source,sourceRef'),
    ('BusinessIdentityStatement',     'BusinessIdentityStatement_source_ref',        'sourceRef'),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_source_field',  'fact,sourceField'),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_value_hash',    'valueHash'),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_public_use',    'publicUseApproved,publicUseApprovedAt'),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_retired_shape', 'retiredAt,status')
),
actual_checks AS (
  SELECT c.relname AS tbl, k.conname, k.convalidated,
         (SELECT string_agg(a.attname COLLATE "C", ',' ORDER BY a.attname COLLATE "C") FROM unnest(k.conkey) x(attnum)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE k.contype = 'c' AND c.relname IN (SELECT tbl FROM new_tables)
),
expected_idx(tbl, idx, uniq, prim, cols, pred) AS (
  -- pred: NULL for a plain index; otherwise the predicate exactly as PostgreSQL deparses it.
  VALUES
    ('BusinessIdentityStatement', 'BusinessIdentityStatement_pkey',                            true,  true,  'id',                          NULL),
    ('BusinessIdentityStatement', 'BusinessIdentityStatement_id_businessId_key',               true,  false, 'id,businessId',               NULL),
    ('BusinessIdentityStatement', 'BusinessIdentityStatement_businessId_status_dimension_idx', false, false, 'businessId,status,dimension', NULL),
    ('BusinessIdentityStatement', 'BusinessIdentityStatement_active_single_key',               true,  false, 'businessId,dimension',
       '((status = ''ACTIVE''::"BusinessIdentityStatus") AND (dimension = ANY (ARRAY[''DESCRIPTION''::"BusinessIdentityDimension", ''PRIMARY_OBJECTIVE''::"BusinessIdentityDimension", ''TONE''::"BusinessIdentityDimension"])))'),
    ('BusinessIdentityStatement', 'BusinessIdentityStatement_active_code_key',                 true,  false, 'businessId,dimension,code',
       '((status = ''ACTIVE''::"BusinessIdentityStatus") AND (code IS NOT NULL))'),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_pkey',                    true,  true,  'id',                NULL),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_id_businessId_key',       true,  false, 'id,businessId',     NULL),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_businessId_status_idx',   false, false, 'businessId,status', NULL),
    ('BusinessIdentityFactAuthority', 'BusinessIdentityFactAuthority_active_fact_key',         true,  false, 'businessId,fact',
       '(status = ''ACTIVE''::"BusinessIdentityStatus")')
),
actual_idx AS (
  SELECT c.relname AS tbl, ic.relname AS idx, i.indisunique AS uniq, i.indisprimary AS prim,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum) AS cols,
         pg_get_expr(i.indpred, i.indrelid) AS pred,
         (i.indisvalid AND i.indisready AND i.indexprs IS NULL AND am.amname = 'btree') AS sound
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_am am ON am.oid = ic.relam
  WHERE c.relname IN (SELECT tbl FROM new_tables)
),
expected_policies(tbl, pol, cmd, has_qual, has_check) AS (
  VALUES
    ('BusinessIdentityStatement',     'p2_identity_statement_select', 'r', true,  false),
    ('BusinessIdentityStatement',     'p2_identity_statement_insert', 'a', false, true),
    ('BusinessIdentityStatement',     'p2_identity_statement_update', 'w', true,  true),
    ('BusinessIdentityFactAuthority', 'p2_identity_fact_select',      'r', true,  false),
    ('BusinessIdentityFactAuthority', 'p2_identity_fact_insert',      'a', false, true),
    ('BusinessIdentityFactAuthority', 'p2_identity_fact_update',      'w', true,  true)
),
actual_policies AS (
  SELECT c.relname AS tbl, pol.polname AS pol, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1)
            FROM unnest(pol.polroles) x) AS roles,
         pg_get_expr(pol.polqual, pol.polrelid) AS qual,
         pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN (SELECT tbl FROM new_tables)
),
policy_match AS (
  SELECT e.tbl, e.pol,
         EXISTS (SELECT 1 FROM actual_policies a, tenant_expr t
                  WHERE a.tbl = e.tbl AND a.pol = e.pol AND a.cmd = e.cmd AND a.permissive AND a.roles = 'public'
                    AND CASE WHEN e.has_qual  THEN a.qual   = t.e ELSE a.qual   IS NULL END
                    AND CASE WHEN e.has_check THEN a.wcheck = t.e ELSE a.wcheck IS NULL END) AS ok
  FROM expected_policies e
),
rels AS (
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relname IN (SELECT tbl FROM new_tables) AND c.relkind IN ('r','p'))
     OR (c.relname IN (SELECT tbl || '_id_seq' FROM new_tables) AND c.relkind = 'S')
),
acl AS (
  SELECT r.relname AS rel, r.relkind,
         g.grantee_oid,
         translate(substring(item::text FROM '^(?:"(?:[^"]|"")*"|[^=]*)=([^/]*)/'), '*', '') AS privs
  FROM rels r
  CROSS JOIN LATERAL unnest(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) AS item
  CROSS JOIN LATERAL (SELECT DISTINCT x.grantee AS grantee_oid FROM aclexplode(ARRAY[item]) x) g
),
runtime_logins AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r
  WHERE r.rolcanlogin AND r.rolname <> current_user  -- the migration role (BYPASSRLS by design) is not the runtime
    AND (r.rolname LIKE 'app\_runtime%'
         OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
             AND pg_has_role(r.oid, 'app_runtime', 'USAGE')))
),
inspected AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls,
         (r.rolname = 'app_runtime'
          OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
              AND pg_has_role(r.oid, 'app_runtime', 'USAGE'))) AS is_runtime
  FROM pg_roles r
  WHERE r.rolname <> current_user AND r.rolname LIKE 'app\_%'
     OR r.oid IN (SELECT oid FROM runtime_logins)
),
effective AS (
  SELECT i.rolname, i.is_runtime, r.relname AS rel, r.relkind,
         coalesce((SELECT string_agg(DISTINCT l COLLATE "C", '' ORDER BY l COLLATE "C")
                     FROM acl a CROSS JOIN LATERAL regexp_split_to_table(a.privs, '') l
                    WHERE a.rel = r.relname AND l <> ''
                      AND (a.grantee_oid = 0 OR pg_has_role(i.oid, a.grantee_oid, 'USAGE'))), '') AS letters
  FROM inspected i CROSS JOIN rels r
),
checks(ord, check_name, ok, detail) AS (
  -- Q0. Migration recorded as applied, finished, not rolled back, and the
  -- recorded checksum is the sha256 of the reviewed migration.sql.
  SELECT 0, 'Q0 migration 20261004090000_p2_business_identity recorded applied (finished, not rolled back, checksum = reviewed file)',
    (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261004090000_p2_business_identity') = 1
    AND EXISTS (SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20261004090000_p2_business_identity'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                  AND checksum = 'ee9b967276290c4ddfe21a97ee886cb4ba173a076adf44187170f9917c569fc6'),
    NULL::text
  UNION ALL
  SELECT 1, 'Q1 four enum types exist with exact labels in order',
    (SELECT count(*) FROM expected_enums e JOIN actual_enums a USING (typ, labels)) = 4,
    (SELECT string_agg(e.typ, ',' ORDER BY e.typ) FROM expected_enums e
      WHERE NOT EXISTS (SELECT 1 FROM actual_enums a WHERE a.typ = e.typ AND a.labels = e.labels))
  UNION ALL
  SELECT 2, 'Q2 columns exact on both new tables (type, not-null, default); no extra column',
    (SELECT bool_and(ok) FROM col_match) AND (SELECT count(*) FROM actual_cols) = 31,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || col AS x FROM col_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.col FROM actual_cols a
        WHERE NOT EXISTS (SELECT 1 FROM expected_cols e WHERE e.tbl = a.tbl AND e.col = a.col)) s)
  UNION ALL
  SELECT 3, 'Q3 exactly one FK per table: businessId -> Business, ON DEL cascade, ON UPD cascade, validated',
    (SELECT count(*) FROM actual_fks) = 2
    AND (SELECT count(*) FROM actual_fks WHERE conname = tbl || '_businessId_fkey'
          AND cols = 'businessId' AND reftbl = 'Business' AND del = 'c' AND upd = 'c' AND convalidated) = 2,
    (SELECT string_agg(conname, ',') FROM actual_fks)
  UNION ALL
  SELECT 4, 'Q4 nine CHECK constraints present + validated on expected columns; no extra CHECK',
    (SELECT count(*) FROM expected_checks e JOIN actual_checks a USING (tbl, conname, cols) WHERE a.convalidated) = 9
    AND (SELECT count(*) FROM actual_checks) = 9,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.conname AS x FROM expected_checks e
        WHERE NOT EXISTS (SELECT 1 FROM actual_checks a WHERE a.convalidated AND a.tbl = e.tbl AND a.conname = e.conname AND a.cols = e.cols)
       UNION ALL
       SELECT 'unexpected:' || a.conname FROM actual_checks a
        WHERE NOT EXISTS (SELECT 1 FROM expected_checks e WHERE e.conname = a.conname)) s)
  UNION ALL
  SELECT 5, 'Q5 indexes exact incl. the three PARTIAL unique indexes with their exact predicates; no extra index',
    (SELECT count(*) FROM expected_idx e JOIN actual_idx a USING (tbl, idx, uniq, prim, cols)
      WHERE a.sound AND a.pred IS NOT DISTINCT FROM e.pred) = 9
    AND (SELECT count(*) FROM actual_idx) = 9,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.idx AS x FROM expected_idx e
        WHERE NOT EXISTS (SELECT 1 FROM actual_idx a WHERE a.sound AND a.tbl = e.tbl AND a.idx = e.idx AND a.uniq = e.uniq
                           AND a.prim = e.prim AND a.cols = e.cols AND a.pred IS NOT DISTINCT FROM e.pred)
       UNION ALL
       SELECT 'unexpected:' || a.idx FROM actual_idx a
        WHERE NOT EXISTS (SELECT 1 FROM expected_idx e WHERE e.idx = a.idx)) s)
  UNION ALL
  SELECT 6, 'Q6 RLS enabled+forced on both new tables',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN (SELECT tbl FROM new_tables) AND c.relkind = 'r'
         AND c.relrowsecurity AND c.relforcerowsecurity) = 2,
    (SELECT string_agg(t.tbl, ',') FROM new_tables t
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                         WHERE c.relname = t.tbl AND c.relrowsecurity AND c.relforcerowsecurity))
  UNION ALL
  SELECT 7, 'Q7 policies exact (6: select/ins/upd per table, permissive, PUBLIC, tenant predicate; no DEL, no ALL, no extra)',
    (SELECT bool_and(ok) FROM policy_match) AND (SELECT count(*) FROM actual_policies) = 6,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || pol AS x FROM policy_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.pol FROM actual_policies a
        WHERE NOT EXISTS (SELECT 1 FROM expected_policies e WHERE e.tbl = a.tbl AND e.pol = a.pol)) s)
  UNION ALL
  SELECT 8, 'Q8 table privileges: runtime (app_runtime + inheriting roles/logins) exactly arw, no d/D; other app_* none',
    EXISTS (SELECT 1 FROM runtime_logins)
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind <> 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END),
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind <> 'S' AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END)
  UNION ALL
  SELECT 9, 'Q9 id sequence privileges: runtime exactly USAGE+SELECT; other app_* none; sequences owned by table.id',
    (SELECT count(*) FROM rels WHERE relkind = 'S') = 2
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind = 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
    AND (SELECT count(*) FROM new_tables t
          WHERE pg_get_serial_sequence(format('%I', t.tbl), 'id') = format('public.%I', t.tbl || '_id_seq')) = 2,
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind = 'S' AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
  UNION ALL
  SELECT 10, 'Q10 PUBLIC holds no privilege on the new tables or their id sequences',
    NOT EXISTS (SELECT 1 FROM acl WHERE grantee_oid = 0 AND privs <> ''),
    (SELECT string_agg(rel, ',') FROM acl WHERE grantee_oid = 0 AND privs <> '')
  UNION ALL
  SELECT 11, 'Q11 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS (runtime login exists)',
    NOT EXISTS (SELECT 1 FROM inspected WHERE rolsuper OR rolbypassrls)
    AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM inspected WHERE rolsuper OR rolbypassrls)
  UNION ALL
  SELECT 12, 'Q12 no user trigger on the new tables (the migration defines none)',
    NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables)),
    (SELECT string_agg(c.relname || '.' || t.tgname, ',') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables))
)
SELECT ord AS n,
       check_name,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       CASE WHEN ok THEN NULL ELSE detail END AS detail
FROM checks
ORDER BY ord;

ROLLBACK;
