-- ============================================================================
-- m5-crm-lead-lifecycle-production-evidence.sql
--
-- Read-only catalog proof that migration
--   20261002090000_crm_lead_lifecycle
-- is in force on this database with exactly its intended security properties.
-- The companion of m5-crm-lead-lifecycle-preflight.sql (run before the apply).
--
-- Output: one row per assertion: check, PASS/FAIL, and (on FAIL only) a detail
-- made of catalog identifiers (table, column, constraint, index, policy or role
-- names, privilege letters) or counts. Then one INFO table of counts.
--
-- NO DATA ROW CONTENT IS READ. Assertions read the system catalog and the
-- migration ledger; Q13 reads Lead / LeadLifecycleEvent only to COUNT (every
-- lead has exactly one `created` step and lifecycleVersion = its step count).
--
-- Privilege letters (aclitem): r=read a=append w=upd d=del D=trunc x=refs
-- t=trigger m=maintain U=usage. Privilege checks are EFFECTIVE (membership and
-- PUBLIC count) for app_runtime and every non-superuser LOGIN role inheriting
-- it (Production's runtime login is app_runtime_prod).
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
tenant_expr(e) AS (
  VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')
),
expected_cols(tbl, col, typ, nn, def) AS (
  VALUES
    ('LeadLifecycleEvent', 'id',             'integer',                        true,  'serial'),
    ('LeadLifecycleEvent', 'businessId',     'integer',                        true,  NULL),
    ('LeadLifecycleEvent', 'leadId',         'integer',                        true,  NULL),
    ('LeadLifecycleEvent', 'seq',            'integer',                        true,  NULL),
    ('LeadLifecycleEvent', 'kind',           'text',                           true,  NULL),
    ('LeadLifecycleEvent', 'fromStatus',     '"LeadStatus"',                   false, NULL),
    ('LeadLifecycleEvent', 'toStatus',       '"LeadStatus"',                   false, NULL),
    ('LeadLifecycleEvent', 'nextActionKind', 'text',                           false, NULL),
    ('LeadLifecycleEvent', 'dueAt',          'timestamp(3) without time zone', false, NULL),
    ('LeadLifecycleEvent', 'previousDueAt',  'timestamp(3) without time zone', false, NULL),
    ('LeadLifecycleEvent', 'amountKind',     'text',                           false, NULL),
    ('LeadLifecycleEvent', 'amount',         'numeric(18,2)',                  false, NULL),
    ('LeadLifecycleEvent', 'actorType',      'text',                           true,  NULL),
    ('LeadLifecycleEvent', 'actorUserId',    'integer',                        false, NULL),
    ('LeadLifecycleEvent', 'source',         'text',                           true,  NULL),
    ('LeadLifecycleEvent', 'evidenceKind',   'text',                           false, NULL),
    ('LeadLifecycleEvent', 'evidenceRef',    'text',                           false, NULL),
    ('LeadLifecycleEvent', 'idempotencyKey', 'text',                           true,  NULL),
    ('LeadLifecycleEvent', 'occurredAt',     'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('LeadLifecycleEvent', 'createdAt',      'timestamp(3) without time zone', true,  'CURRENT_TIMESTAMP'),
    ('Lead', 'lifecycleVersion', 'integer',                        true,  '0'),
    ('Lead', 'nextActionKind',   'text',                           false, NULL),
    ('Lead', 'firstHandledAt',   'timestamp(3) without time zone', false, NULL),
    ('Lead', 'valueEstimate',    'numeric(18,2)',                  false, NULL),
    ('Lead', 'finalPrice',       'numeric(18,2)',                  false, NULL)
),
actual_cols AS (
  SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def,
         pg_get_serial_sequence(format('%I', c.relname), a.attname) AS serial_seq
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname IN ('LeadLifecycleEvent', 'Lead')
),
col_match AS (
  SELECT e.tbl, e.col,
         EXISTS (SELECT 1 FROM actual_cols a
                  WHERE a.tbl = e.tbl AND a.col = e.col AND a.typ = e.typ AND a.nn = e.nn
                    AND CASE
                          WHEN e.def IS NULL THEN a.def IS NULL
                          WHEN e.def = 'serial' THEN a.serial_seq = format('public.%I', e.tbl || '_id_seq')
                          ELSE a.def = e.def
                        END) AS ok
  FROM expected_cols e
),
expected_fks(conname, cols, reftbl, refcols, del, upd) AS (
  VALUES
    ('LeadLifecycleEvent_businessId_fkey',    'businessId',        'Business', 'id',            'c', 'c'),
    ('LeadLifecycleEvent_leadId_fkey',        'leadId',            'Lead',     'id',            'c', 'c'),
    ('LeadLifecycleEvent_leadId_tenant_fkey', 'businessId,leadId', 'Lead',     'businessId,id', 'c', 'a')
),
actual_fks AS (
  SELECT k.conname,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols,
         p.relname AS reftbl,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum) AS refcols,
         k.confdeltype::text AS del, k.confupdtype::text AS upd, k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_class p ON p.oid = k.confrelid
  WHERE k.contype = 'f' AND c.relname = 'LeadLifecycleEvent'
),
expected_checks(tbl, conname) AS (
  VALUES
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_kind_vocab'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_seq_range'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_status_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_nextActionKind_vocab'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_next_action_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_reschedule_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_amount_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_actorType_vocab'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_actor_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_source_vocab'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_evidence_shape'),
    ('LeadLifecycleEvent', 'LeadLifecycleEvent_idempotencyKey_format'),
    ('Lead', 'Lead_nextActionKind_vocab'),
    ('Lead', 'Lead_nextAction_has_due'),
    ('Lead', 'Lead_lifecycleVersion_range'),
    ('Lead', 'Lead_money_nonnegative'),
    ('Lead', 'Lead_currency_iso')
),
actual_checks AS (
  SELECT c.relname AS tbl, k.conname, k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE k.contype = 'c' AND (c.relname = 'LeadLifecycleEvent' OR k.conname IN (SELECT conname FROM expected_checks))
),
expected_idx(idx, uniq, prim, cols) AS (
  VALUES
    ('LeadLifecycleEvent_pkey',                          true,  true,  'id'),
    ('LeadLifecycleEvent_businessId_idempotencyKey_key', true,  false, 'businessId,idempotencyKey'),
    ('LeadLifecycleEvent_businessId_leadId_seq_key',     true,  false, 'businessId,leadId,seq'),
    ('LeadLifecycleEvent_businessId_kind_occurredAt_idx', false, false, 'businessId,kind,occurredAt')
),
actual_idx AS (
  SELECT ic.relname AS idx, i.indisunique AS uniq, i.indisprimary AS prim,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum) AS cols,
         (i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree') AS sound
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_am am ON am.oid = ic.relam
  WHERE c.relname = 'LeadLifecycleEvent'
),
expected_policies(pol, cmd, has_qual, has_check) AS (
  -- polcmd: r=SELECT a=INS w=UPD d=DEL *=ALL. Append-only: no UPD, no DEL, no ALL.
  VALUES
    ('lead_lifecycle_tenant_read',   'r', true,  false),
    ('lead_lifecycle_tenant_insert', 'a', false, true)
),
actual_policies AS (
  SELECT pol.polname AS pol, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1)
            FROM unnest(pol.polroles) x) AS roles,
         pg_get_expr(pol.polqual, pol.polrelid) AS qual,
         pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname = 'LeadLifecycleEvent'
),
policy_match AS (
  SELECT e.pol,
         EXISTS (SELECT 1 FROM actual_policies a, tenant_expr t
                  WHERE a.pol = e.pol AND a.cmd = e.cmd AND a.permissive AND a.roles = 'public'
                    AND CASE WHEN e.has_qual  THEN a.qual   = t.e ELSE a.qual   IS NULL END
                    AND CASE WHEN e.has_check THEN a.wcheck = t.e ELSE a.wcheck IS NULL END) AS ok
  FROM expected_policies e
),
rels AS (
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relname = 'LeadLifecycleEvent' AND c.relkind IN ('r', 'p'))
     OR (c.relname = 'LeadLifecycleEvent_id_seq' AND c.relkind = 'S')
),
acl AS (
  SELECT r.relname AS rel, r.relkind, g.grantee_oid,
         translate(substring(item::text FROM '^(?:"(?:[^"]|"")*"|[^=]*)=([^/]*)/'), '*', '') AS privs
  FROM rels r
  CROSS JOIN LATERAL unnest(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) AS item
  CROSS JOIN LATERAL (SELECT DISTINCT x.grantee AS grantee_oid FROM aclexplode(ARRAY[item]) x) g
),
runtime_logins AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r
  WHERE r.rolcanlogin
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
  WHERE r.rolname LIKE 'app\_%' OR r.oid IN (SELECT oid FROM runtime_logins)
),
effective AS (
  SELECT i.rolname, i.is_runtime, r.relname AS rel, r.relkind,
         coalesce((SELECT string_agg(DISTINCT l COLLATE "C", '' ORDER BY l COLLATE "C")
                     FROM acl a CROSS JOIN LATERAL regexp_split_to_table(a.privs, '') l
                    WHERE a.rel = r.relname AND l <> ''
                      AND (a.grantee_oid = 0 OR pg_has_role(i.oid, a.grantee_oid, 'USAGE'))), '') AS letters
  FROM inspected i CROSS JOIN rels r
),
coverage AS (
  SELECT
    (SELECT count(*) FROM "Lead") AS leads,
    (SELECT count(*) FROM "Lead" l
      WHERE (SELECT count(*) FROM "LeadLifecycleEvent" e
              WHERE e."leadId" = l."id" AND e."businessId" = l."businessId" AND e."kind" = 'created') <> 1) AS without_one_created,
    (SELECT count(*) FROM "Lead" l
      WHERE l."lifecycleVersion" <> (SELECT count(*) FROM "LeadLifecycleEvent" e
                                      WHERE e."leadId" = l."id" AND e."businessId" = l."businessId")) AS version_mismatch
),
checks(ord, check_name, ok, detail) AS (
  SELECT 0, 'Q0 migration 20261002090000_crm_lead_lifecycle recorded applied (finished, not rolled back, checksum = reviewed file)',
    (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261002090000_crm_lead_lifecycle') = 1
    AND EXISTS (SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20261002090000_crm_lead_lifecycle'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                  AND checksum = '424d29355d8599130ceb772892d246e4289c492484d5f424e203592e387c26fe'),
    (SELECT string_agg(coalesce(left(checksum, 12), 'null') || '/' || (finished_at IS NOT NULL)::text
                       || '/' || (rolled_back_at IS NULL)::text, ',')
       FROM _prisma_migrations WHERE migration_name = '20261002090000_crm_lead_lifecycle')
  UNION ALL
  SELECT 1, 'Q1 ledger: no unfinished or rolled-back row',
    NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
    (SELECT string_agg(migration_name, ',') FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL
  SELECT 2, 'Q2 columns exact on LeadLifecycleEvent (20) + Lead lifecycle / money columns (type, not-null, default)',
    (SELECT bool_and(ok) FROM col_match)
    AND (SELECT count(*) FROM actual_cols WHERE tbl = 'LeadLifecycleEvent') = 20,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || col AS x FROM col_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.col FROM actual_cols a
        WHERE a.tbl = 'LeadLifecycleEvent'
          AND NOT EXISTS (SELECT 1 FROM expected_cols e WHERE e.tbl = a.tbl AND e.col = a.col)) s)
  UNION ALL
  SELECT 3, 'Q3 foreign keys exact (3, incl. the composite tenant key; actions; validated); no extra FK',
    (SELECT count(*) FROM expected_fks e JOIN actual_fks a USING (conname, cols, reftbl, refcols, del, upd) WHERE a.convalidated) = 3
    AND (SELECT count(*) FROM actual_fks) = 3,
    (SELECT string_agg(conname, ',') FROM actual_fks)
  UNION ALL
  SELECT 4, 'Q4 CHECK constraints present + validated (12 on the history, 5 on Lead); no extra CHECK on the history',
    (SELECT count(*) FROM expected_checks e JOIN actual_checks a USING (tbl, conname) WHERE a.convalidated) = 17
    AND (SELECT count(*) FROM actual_checks WHERE tbl = 'LeadLifecycleEvent') = 12,
    (SELECT string_agg(e.conname, ',') FROM expected_checks e
      WHERE NOT EXISTS (SELECT 1 FROM actual_checks a WHERE a.convalidated AND a.tbl = e.tbl AND a.conname = e.conname))
  UNION ALL
  SELECT 5, 'Q5 indexes exact (4: pkey, idempotency key, per-lead seq, kind/time); no extra index',
    (SELECT count(*) FROM expected_idx e JOIN actual_idx a USING (idx, uniq, prim, cols) WHERE a.sound) = 4
    AND (SELECT count(*) FROM actual_idx) = 4,
    (SELECT string_agg(idx, ',') FROM actual_idx)
  UNION ALL
  SELECT 6, 'Q6 RLS enabled+forced on LeadLifecycleEvent',
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             WHERE c.relname = 'LeadLifecycleEvent' AND c.relrowsecurity AND c.relforcerowsecurity),
    NULL::text
  UNION ALL
  SELECT 7, 'Q7 policies exact (2: read + ins, permissive, PUBLIC, tenant predicate; no UPD, no DEL, no ALL)',
    (SELECT bool_and(ok) FROM policy_match) AND (SELECT count(*) FROM actual_policies) = 2,
    (SELECT string_agg(pol || ':' || cmd, ',') FROM actual_policies)
  UNION ALL
  SELECT 8, 'Q8 table privileges: runtime (app_runtime + inheriting logins) exactly ar (append-only: no w/d/D); other app_* none',
    EXISTS (SELECT 1 FROM runtime_logins)
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind <> 'S' AND letters <> CASE WHEN is_runtime THEN 'ar' ELSE '' END),
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname) FROM effective
      WHERE relkind <> 'S' AND letters <> CASE WHEN is_runtime THEN 'ar' ELSE '' END)
  UNION ALL
  SELECT 9, 'Q9 id sequence privileges: runtime exactly USAGE+SELECT; other app_* none',
    (SELECT count(*) FROM rels WHERE relkind = 'S') = 1
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind = 'S' AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END),
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname) FROM effective
      WHERE relkind = 'S' AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
  UNION ALL
  SELECT 10, 'Q10 PUBLIC holds no privilege on the history or its id sequence',
    NOT EXISTS (SELECT 1 FROM acl WHERE grantee_oid = 0 AND privs <> ''),
    (SELECT string_agg(rel, ',') FROM acl WHERE grantee_oid = 0 AND privs <> '')
  UNION ALL
  SELECT 11, 'Q11 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS (runtime login exists)',
    NOT EXISTS (SELECT 1 FROM inspected WHERE rolsuper OR rolbypassrls) AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM inspected WHERE rolsuper OR rolbypassrls)
  UNION ALL
  SELECT 12, 'Q12 no user trigger on LeadLifecycleEvent (the migration defines none)',
    NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE NOT t.tgisinternal AND c.relname = 'LeadLifecycleEvent'),
    NULL::text
  UNION ALL
  SELECT 13, 'Q13 lifecycle coverage: every Lead has exactly one created step and lifecycleVersion = its step count',
    (SELECT without_one_created = 0 AND version_mismatch = 0 FROM coverage),
    (SELECT 'leads=' || leads || ' without_one_created=' || without_one_created || ' version_mismatch=' || version_mismatch FROM coverage)
)
SELECT ord, check_name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, CASE WHEN ok THEN NULL ELSE detail END AS detail
FROM checks ORDER BY ord;

-- INFO: counts only.
SELECT 'I' || ord AS id, what, n
FROM (
  SELECT 1 AS ord, 'Lead rows' AS what, (SELECT count(*) FROM "Lead") AS n
  UNION ALL SELECT 2, 'LeadLifecycleEvent rows', (SELECT count(*) FROM "LeadLifecycleEvent")
  UNION ALL SELECT 3, 'LeadLifecycleEvent rows with source BACKFILL', (SELECT count(*) FROM "LeadLifecycleEvent" WHERE "source" = 'BACKFILL')
  UNION ALL SELECT 4, 'LeadLifecycleEvent rows observed after the migration (not BACKFILL)', (SELECT count(*) FROM "LeadLifecycleEvent" WHERE "source" <> 'BACKFILL')
  UNION ALL SELECT 5, 'Lead rows with a typed next action', (SELECT count(*) FROM "Lead" WHERE "nextActionKind" IS NOT NULL)
) s ORDER BY ord;

ROLLBACK;
