-- ============================================================================
-- m4-identity-routing-production-evidence.sql
--
-- Read-only catalog proof that migration
--   20261001090000_m4_identity_routing   (main revision e57af1df, PR #578)
-- is in force on this database with exactly its intended security properties.
-- The companion of m4-identity-routing-preflight.sql (run before the apply).
--
-- Output: one row per assertion: check, PASS/FAIL, and (on FAIL only) a detail
-- made of catalog identifiers (table, column, constraint, index, policy or role
-- names, privilege letters). Then one INFO table of row counts.
--
-- NO DATA ROW CONTENT IS READ. The assertions read the system catalog
-- (pg_class, pg_attribute, pg_attrdef, pg_constraint, pg_index, pg_policy,
-- pg_trigger, pg_roles, relacl) and the migration ledger (_prisma_migrations).
-- The INFO table is counts only: no id, name, phone, email, hash or message
-- text is ever selected.
--
-- Scope: the two new tables IdentityLink and IdentityProposal (columns, FKs
-- with their referential actions, CHECKs, indexes including the partial "one
-- active owner per identifier" key, RLS, the exact policy set, effective
-- privileges on the tables and their id sequences, no trigger), plus the eight
-- columns and four CHECKs the migration adds to IntakeNormalizedEvent.
--
-- Privilege letters (aclitem): r=read a=append w=upd d=del D=trunc x=refs
-- t=trigger m=maintain U=usage. Privilege checks are EFFECTIVE: a privilege
-- reached through role membership (INHERIT) or PUBLIC counts, and every role
-- whose name starts with app_ is inspected, group AND login roles, plus every
-- non-superuser LOGIN role that inherits app_runtime (Production's runtime
-- login is app_runtime_prod).
--
-- HONEST COUNTS: row_security is off for this transaction; a role subject to
-- row-level security raises an error instead of an undercount.
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

WITH
new_tables(tbl) AS (
  VALUES ('IdentityLink'), ('IdentityProposal')
),
tenant_expr(e) AS (
  -- The tenant predicate exactly as PostgreSQL deparses the migration text.
  VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')
),
expected_cols(tbl, col, typ, nn, def) AS (
  -- def: NULL = no default; 'serial' = default draws from the owned
  -- <table>_id_seq sequence; otherwise the exact deparsed default.
  VALUES
    ('IdentityLink',     'id',                  'integer',                        true,  'serial'),
    ('IdentityLink',     'businessId',          'integer',                        true,  NULL),
    ('IdentityLink',     'customerId',          'integer',                        true,  NULL),
    ('IdentityLink',     'kind',                'text',                           true,  NULL),
    ('IdentityLink',     'scope',               'text',                           true,  '''''::text'),
    ('IdentityLink',     'valueHash',           'text',                           false, NULL),
    ('IdentityLink',     'method',              'text',                           true,  NULL),
    ('IdentityLink',     'status',              'text',                           true,  '''active''::text'),
    ('IdentityLink',     'sourceIntakeEventId', 'integer',                        false, NULL),
    ('IdentityLink',     'proposalId',          'integer',                        false, NULL),
    ('IdentityLink',     'revokedAt',           'timestamp(3) without time zone', false, NULL),
    ('IdentityLink',     'revokedByUserId',     'integer',                        false, NULL),
    ('IdentityLink',     'revokeReason',        'text',                           false, NULL),
    ('IdentityLink',     'createdAt',           'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('IdentityLink',     'updatedAt',           'timestamp(3) without time zone', true,  NULL),
    ('IdentityProposal', 'id',                  'integer',                        true,  'serial'),
    ('IdentityProposal', 'businessId',          'integer',                        true,  NULL),
    ('IdentityProposal', 'intakeEventId',       'integer',                        true,  NULL),
    ('IdentityProposal', 'candidateCustomerId', 'integer',                        true,  NULL),
    ('IdentityProposal', 'leadId',              'integer',                        false, NULL),
    ('IdentityProposal', 'reason',              'text',                           true,  NULL),
    ('IdentityProposal', 'state',               'text',                           true,  '''proposed''::text'),
    ('IdentityProposal', 'proposedLinks',       'jsonb',                          false, '''[]''::jsonb'),
    ('IdentityProposal', 'evidence',            'jsonb',                          false, '''{}''::jsonb'),
    ('IdentityProposal', 'evidenceFingerprint', 'text',                           true,  NULL),
    ('IdentityProposal', 'appliedEffects',      'jsonb',                          false, NULL),
    ('IdentityProposal', 'policyVersion',       'text',                           true,  NULL),
    ('IdentityProposal', 'decidedAt',           'timestamp(3) without time zone', false, NULL),
    ('IdentityProposal', 'decidedByUserId',     'integer',                        false, NULL),
    ('IdentityProposal', 'createdAt',           'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('IdentityProposal', 'updatedAt',           'timestamp(3) without time zone', true,  NULL),
    -- columns the migration adds to IntakeNormalizedEvent
    ('IntakeNormalizedEvent', 'identityState',          'text',    false, NULL),
    ('IntakeNormalizedEvent', 'identityPolicyVersion',  'text',    false, NULL),
    ('IntakeNormalizedEvent', 'identityCustomerId',     'integer', false, NULL),
    ('IntakeNormalizedEvent', 'identityEvidence',       'jsonb',   false, NULL),
    ('IntakeNormalizedEvent', 'identityCandidateCount', 'integer', false, NULL),
    ('IntakeNormalizedEvent', 'routingRule',            'text',    false, NULL),
    ('IntakeNormalizedEvent', 'routingDestination',     'text',    false, NULL),
    ('IntakeNormalizedEvent', 'ownerReviewRequired',    'boolean', true,  'false')
),
actual_cols AS (
  SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def,
         pg_get_serial_sequence(format('%I', c.relname), a.attname) AS serial_seq
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND c.relname IN ('IdentityLink', 'IdentityProposal', 'IntakeNormalizedEvent')
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
expected_fks(tbl, conname, cols, reftbl, refcols, del, upd, setcols) AS (
  -- confdeltype / confupdtype: a=no action r=restrict c=cascade n=set null d=set default.
  -- setcols: the column list of a column-scoped SET NULL (PG 15+), else NULL.
  VALUES
    ('IdentityLink',     'IdentityLink_businessId_fkey',                     'businessId',                     'Business',    'id',            'c', 'c', NULL),
    ('IdentityLink',     'IdentityLink_customerId_fkey',                     'customerId',                     'Customer',    'id',            'c', 'c', NULL),
    ('IdentityLink',     'IdentityLink_customerId_tenant_fkey',              'businessId,customerId',          'Customer',    'businessId,id', 'c', 'a', NULL),
    ('IdentityProposal', 'IdentityProposal_businessId_fkey',                 'businessId',                     'Business',    'id',            'c', 'c', NULL),
    ('IdentityProposal', 'IdentityProposal_businessId_intakeEventId_fkey',   'businessId,intakeEventId',       'IntakeEvent', 'businessId,id', 'c', 'c', NULL),
    ('IdentityProposal', 'IdentityProposal_candidateCustomerId_fkey',        'candidateCustomerId',            'Customer',    'id',            'c', 'c', NULL),
    ('IdentityProposal', 'IdentityProposal_candidateCustomerId_tenant_fkey', 'businessId,candidateCustomerId', 'Customer',    'businessId,id', 'c', 'a', NULL),
    ('IdentityProposal', 'IdentityProposal_leadId_tenant_fkey',              'businessId,leadId',              'Lead',        'businessId,id', 'n', 'a', 'leadId')
),
actual_fks AS (
  SELECT c.relname AS tbl, k.conname,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols,
         p.relname AS reftbl,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum) AS refcols,
         k.confdeltype::text AS del, k.confupdtype::text AS upd,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.confdelsetcols) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS setcols,
         k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_class p ON p.oid = k.confrelid
  WHERE k.contype = 'f' AND c.relname IN (SELECT tbl FROM new_tables)
),
expected_checks(tbl, conname) AS (
  VALUES
    ('IdentityLink',          'IdentityLink_kind_vocab'),
    ('IdentityLink',          'IdentityLink_scope_rule'),
    ('IdentityLink',          'IdentityLink_valueHash_format'),
    ('IdentityLink',          'IdentityLink_method_vocab'),
    ('IdentityLink',          'IdentityLink_status_vocab'),
    ('IdentityLink',          'IdentityLink_revocation_shape'),
    ('IdentityProposal',      'IdentityProposal_reason_vocab'),
    ('IdentityProposal',      'IdentityProposal_state_vocab'),
    ('IdentityProposal',      'IdentityProposal_fingerprint_format'),
    ('IdentityProposal',      'IdentityProposal_policyVersion_format'),
    ('IdentityProposal',      'IdentityProposal_decision_shape'),
    ('IntakeNormalizedEvent', 'IntakeNormalizedEvent_identityState_vocab'),
    ('IntakeNormalizedEvent', 'IntakeNormalizedEvent_routingDestination_vocab'),
    ('IntakeNormalizedEvent', 'IntakeNormalizedEvent_routingRule_format'),
    ('IntakeNormalizedEvent', 'IntakeNormalizedEvent_identityCandidateCount_range')
),
actual_checks AS (
  SELECT c.relname AS tbl, k.conname, k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE k.contype = 'c'
    AND (c.relname IN (SELECT tbl FROM new_tables)
         OR k.conname IN (SELECT conname FROM expected_checks))
),
expected_idx(tbl, idx, uniq, prim, cols, pred) AS (
  -- pred: the deparsed partial-index predicate, or NULL for a plain index.
  VALUES
    ('IdentityLink',     'IdentityLink_pkey',                                   true,  true,  'id',                                    NULL),
    ('IdentityLink',     'IdentityLink_active_identifier_key',                  true,  false, 'businessId,kind,scope,valueHash',       '(status = ''active''::text)'),
    ('IdentityLink',     'IdentityLink_businessId_customerId_idx',              false, false, 'businessId,customerId',                 NULL),
    ('IdentityProposal', 'IdentityProposal_pkey',                               true,  true,  'id',                                    NULL),
    ('IdentityProposal', 'IdentityProposal_event_candidate_key',                true,  false, 'businessId,intakeEventId,candidateCustomerId', NULL),
    ('IdentityProposal', 'IdentityProposal_businessId_state_idx',               false, false, 'businessId,state',                      NULL),
    ('IdentityProposal', 'IdentityProposal_businessId_candidateCustomerId_idx', false, false, 'businessId,candidateCustomerId',        NULL)
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
  -- polcmd: r=SELECT a=INS w=UPD d=DEL *=ALL. All PERMISSIVE, role PUBLIC,
  -- every present expression is exactly the tenant predicate. No DEL, no ALL.
  VALUES
    ('IdentityLink',     'identity_link_tenant_read',       'r', true,  false),
    ('IdentityLink',     'identity_link_tenant_insert',     'a', false, true),
    ('IdentityLink',     'identity_link_tenant_update',     'w', true,  true),
    ('IdentityProposal', 'identity_proposal_tenant_read',   'r', true,  false),
    ('IdentityProposal', 'identity_proposal_tenant_insert', 'a', false, true),
    ('IdentityProposal', 'identity_proposal_tenant_update', 'w', true,  true)
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
                  WHERE a.tbl = e.tbl AND a.pol = e.pol AND a.cmd = e.cmd AND a.permissive
                    AND a.roles = 'public'
                    AND CASE WHEN e.has_qual  THEN a.qual   = t.e ELSE a.qual   IS NULL END
                    AND CASE WHEN e.has_check THEN a.wcheck = t.e ELSE a.wcheck IS NULL END) AS ok
  FROM expected_policies e
),
rels AS (
  -- The two tables and their id sequences.
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relname IN (SELECT tbl FROM new_tables) AND c.relkind IN ('r','p'))
     OR (c.relname IN (SELECT tbl || '_id_seq' FROM new_tables) AND c.relkind = 'S')
),
acl AS (
  -- One row per aclitem. grantee_oid 0 = PUBLIC. privs = the privilege letters
  -- of that item with pass-on marks (*) stripped. A NULL relacl means the
  -- built-in default (owner only), made explicit with acldefault().
  SELECT r.relname AS rel, r.relkind,
         g.grantee_oid,
         translate(substring(item::text FROM '^(?:"(?:[^"]|"")*"|[^=]*)=([^/]*)/'), '*', '') AS privs
  FROM rels r
  CROSS JOIN LATERAL unnest(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) AS item
  CROSS JOIN LATERAL (SELECT DISTINCT x.grantee AS grantee_oid FROM aclexplode(ARRAY[item]) x) g
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
effective AS (
  -- (role, relation, sorted letters) the role holds on the relation through
  -- any aclitem whose grantee it is, inherits, or that is PUBLIC.
  SELECT i.rolname, i.is_runtime, r.relname AS rel, r.relkind,
         coalesce((SELECT string_agg(DISTINCT l COLLATE "C", '' ORDER BY l COLLATE "C")
                     FROM acl a CROSS JOIN LATERAL regexp_split_to_table(a.privs, '') l
                    WHERE a.rel = r.relname AND l <> ''
                      AND (a.grantee_oid = 0 OR pg_has_role(i.oid, a.grantee_oid, 'USAGE'))), '') AS letters
  FROM inspected i CROSS JOIN rels r
),
checks(ord, check_name, ok, detail) AS (
  -- Q0. Migration recorded as applied, finished, not rolled back, and the
  -- recorded checksum is the sha256 of the reviewed migration.sql at e57af1df.
  SELECT 0, 'Q0 migration 20261001090000_m4_identity_routing recorded applied (finished, not rolled back, checksum = e57af1df file)',
    (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261001090000_m4_identity_routing') = 1
    AND EXISTS (SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20261001090000_m4_identity_routing'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                  AND checksum = 'fe4e9ee4c913b36fdb28e2373a5aeeb27bd9b3a65c5217a29ad111a7c7c3c901'),
    (SELECT string_agg(coalesce(left(checksum, 12), 'null') || '/' || (finished_at IS NOT NULL)::text
                       || '/' || (rolled_back_at IS NULL)::text, ',')
       FROM _prisma_migrations WHERE migration_name = '20261001090000_m4_identity_routing')
  UNION ALL
  -- Q1. The ledger as a whole: no unfinished or rolled-back row.
  SELECT 1, 'Q1 ledger: no unfinished or rolled-back row',
    NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
    (SELECT string_agg(migration_name, ',') FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL
  -- Q2. Columns: exact column set on the two new tables; the eight added
  -- IntakeNormalizedEvent columns present with type, nullability, default.
  SELECT 2, 'Q2 columns exact on new tables + 8 added IntakeNormalizedEvent columns (type, not-null, default)',
    (SELECT bool_and(ok) FROM col_match)
    AND (SELECT count(*) FROM actual_cols WHERE tbl IN (SELECT tbl FROM new_tables)) = 31,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || col AS x FROM col_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.col FROM actual_cols a
        WHERE a.tbl IN (SELECT tbl FROM new_tables)
          AND NOT EXISTS (SELECT 1 FROM expected_cols e WHERE e.tbl = a.tbl AND e.col = a.col)) s)
  UNION ALL
  -- Q3. Foreign keys exact (columns, target, referential actions, the SET NULL
  -- column list, validated); no other FK on the new tables. Includes the three
  -- composite (businessId, id) tenant keys and the composite IntakeEvent key.
  SELECT 3, 'Q3 foreign keys exact (8, incl. 4 composite tenant keys; actions, SET NULL (leadId), validated); no extra FK',
    (SELECT count(*) FROM expected_fks e JOIN actual_fks a USING (tbl, conname, cols, reftbl, refcols, del, upd)
      WHERE a.convalidated AND a.setcols IS NOT DISTINCT FROM e.setcols) = 8
    AND (SELECT count(*) FROM actual_fks) = 8,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.conname AS x FROM expected_fks e
        WHERE NOT EXISTS (SELECT 1 FROM actual_fks a WHERE a.convalidated
                            AND (a.tbl, a.conname, a.cols, a.reftbl, a.refcols, a.del, a.upd)
                              = (e.tbl, e.conname, e.cols, e.reftbl, e.refcols, e.del, e.upd)
                            AND a.setcols IS NOT DISTINCT FROM e.setcols)
       UNION ALL
       SELECT 'unexpected:' || a.conname FROM actual_fks a
        WHERE NOT EXISTS (SELECT 1 FROM expected_fks e WHERE e.conname = a.conname)) s)
  UNION ALL
  -- Q4. CHECK constraints present and validated (11 on the new tables, 4 on
  -- IntakeNormalizedEvent); no other CHECK on the new tables.
  SELECT 4, 'Q4 CHECK constraints present + validated (15); no extra CHECK on new tables',
    (SELECT count(*) FROM expected_checks e JOIN actual_checks a USING (tbl, conname) WHERE a.convalidated) = 15
    AND (SELECT count(*) FROM actual_checks) = 15,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.conname AS x FROM expected_checks e
        WHERE NOT EXISTS (SELECT 1 FROM actual_checks a WHERE a.convalidated AND a.tbl = e.tbl AND a.conname = e.conname)
       UNION ALL
       SELECT 'unexpected:' || a.conname FROM actual_checks a
        WHERE NOT EXISTS (SELECT 1 FROM expected_checks e WHERE e.conname = a.conname)) s)
  UNION ALL
  -- Q5. Indexes exact (unique/primary, column order, predicate, valid btree);
  -- the partial "one ACTIVE owner per identifier" key is present with its
  -- predicate; no other index on the new tables.
  SELECT 5, 'Q5 indexes exact (7, incl. partial active-identifier unique key); no extra index on new tables',
    (SELECT count(*) FROM expected_idx e JOIN actual_idx a USING (tbl, idx, uniq, prim, cols)
      WHERE a.sound AND a.pred IS NOT DISTINCT FROM e.pred) = 7
    AND (SELECT count(*) FROM actual_idx) = 7,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.idx AS x FROM expected_idx e
        WHERE NOT EXISTS (SELECT 1 FROM actual_idx a WHERE a.sound AND (a.tbl, a.idx, a.uniq, a.prim, a.cols)
                                                        = (e.tbl, e.idx, e.uniq, e.prim, e.cols)
                                                     AND a.pred IS NOT DISTINCT FROM e.pred)
       UNION ALL
       SELECT 'unexpected:' || a.idx FROM actual_idx a
        WHERE NOT EXISTS (SELECT 1 FROM expected_idx e WHERE e.idx = a.idx)) s)
  UNION ALL
  -- Q6. RLS enabled and forced on both new tables.
  SELECT 6, 'Q6 RLS enabled+forced on IdentityLink, IdentityProposal',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN (SELECT tbl FROM new_tables) AND c.relkind = 'r'
         AND c.relrowsecurity AND c.relforcerowsecurity) = 2,
    (SELECT string_agg(t.tbl, ',') FROM new_tables t
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                         WHERE c.relname = t.tbl AND c.relrowsecurity AND c.relforcerowsecurity))
  UNION ALL
  -- Q7. Policy set exact: per table one SELECT (USING tenant), one INS (WITH
  -- CHECK tenant), one UPD (USING + WITH CHECK tenant); all permissive, role
  -- PUBLIC; no DEL policy, no FOR ALL policy, nothing else.
  SELECT 7, 'Q7 policies exact (6: read/ins/upd per table, permissive, PUBLIC, tenant predicate; no DEL, no ALL, no extra)',
    (SELECT bool_and(ok) FROM policy_match)
    AND (SELECT count(*) FROM actual_policies) = 6,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || pol AS x FROM policy_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.pol FROM actual_policies a
        WHERE NOT EXISTS (SELECT 1 FROM expected_policies e WHERE e.tbl = a.tbl AND e.pol = a.pol)) s)
  UNION ALL
  -- Q8. Effective table privileges: app_runtime and every role / login that
  -- inherits it hold exactly r,a,w (no d, no D, no x/t/m); every other app_*
  -- role holds nothing; at least one runtime login exists.
  SELECT 8, 'Q8 table privileges: runtime (app_runtime + inheriting roles/logins) exactly arw, no d/D; other app_* none',
    EXISTS (SELECT 1 FROM runtime_logins)
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind <> 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END),
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind <> 'S' AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END)
  UNION ALL
  -- Q9. Effective sequence privileges: runtime exactly U + r (USAGE, SELECT;
  -- no w); every other app_* role nothing; the sequences are owned by <table>.id.
  SELECT 9, 'Q9 id sequence privileges: runtime exactly USAGE+SELECT; other app_* none; sequences owned by table.id',
    (SELECT count(*) FROM rels WHERE relkind = 'S') = 2
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind = 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
    AND (SELECT count(*) FROM new_tables t
          WHERE pg_get_serial_sequence(format('%I', t.tbl), 'id') = format('public.%I', t.tbl || '_id_seq')) = 2,
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind = 'S' AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
  UNION ALL
  -- Q10. PUBLIC holds nothing on the two tables or their sequences.
  SELECT 10, 'Q10 PUBLIC holds no privilege on the two tables or their id sequences',
    NOT EXISTS (SELECT 1 FROM acl WHERE grantee_oid = 0 AND privs <> ''),
    (SELECT string_agg(rel, ',') FROM acl WHERE grantee_oid = 0 AND privs <> '')
  UNION ALL
  -- Q11. No app_* role or runtime login can step around RLS by attribute.
  SELECT 11, 'Q11 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS (runtime login exists)',
    NOT EXISTS (SELECT 1 FROM inspected WHERE rolsuper OR rolbypassrls)
    AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM inspected WHERE rolsuper OR rolbypassrls)
  UNION ALL
  -- Q12. The migration attaches no trigger: no user trigger on the new tables.
  SELECT 12, 'Q12 no user trigger on the two new tables (the migration defines none)',
    NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables)),
    (SELECT string_agg(c.relname || '.' || t.tgname, ',') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables))
)
SELECT ord,
       check_name,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       CASE WHEN ok THEN NULL ELSE detail END AS detail
FROM checks
ORDER BY ord;

-- INFO: counts only. Right after the apply and before the M4 code ships, the
-- two new tables are empty and no IntakeNormalizedEvent row carries an M4
-- conclusion; after the code ships these grow with real traffic.
SELECT 'I' || ord AS id, what, n
FROM (
  SELECT 1 AS ord, 'IdentityLink rows' AS what, (SELECT count(*) FROM "IdentityLink") AS n
  UNION ALL SELECT 2, 'IdentityLink rows with status active', (SELECT count(*) FROM "IdentityLink" WHERE status = 'active')
  UNION ALL SELECT 3, 'IdentityProposal rows', (SELECT count(*) FROM "IdentityProposal")
  UNION ALL SELECT 4, 'IntakeNormalizedEvent rows', (SELECT count(*) FROM "IntakeNormalizedEvent")
  UNION ALL SELECT 5, 'IntakeNormalizedEvent rows with an identityState', (SELECT count(*) FROM "IntakeNormalizedEvent" WHERE "identityState" IS NOT NULL)
) s ORDER BY ord;

ROLLBACK;
