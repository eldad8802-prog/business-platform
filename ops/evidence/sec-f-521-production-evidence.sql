-- ============================================================================
-- sec-f-521-production-evidence.sql
--
-- Read-only catalog proof that migration
--   20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events
-- (PR #521) is in force on this database.
--
-- Output: one row per assertion: check, PASS/FAIL, and (on FAIL only) a detail
-- made of catalog identifiers (table, trigger, policy, function or role names).
--
-- NO DATA ROWS ARE READ. Every query reads the system catalog (pg_class,
-- pg_trigger, pg_proc, pg_policy, pg_constraint, pg_index, pg_attribute,
-- pg_roles, relacl/proacl) or the migration ledger (_prisma_migrations).
-- No business row, name, amount, email or event payload is ever selected.
--
-- The behaviour of the five guard functions is proven in fresh labs by the
-- SEC-F migration battery; P3 ties that behaviour to this database by matching
-- md5(prosrc) of each function against the reviewed migration text.
--
-- Privilege letters (aclitem): r=read a=append w=upd d=del D=trunc.
-- Grantee names are resolved through aclexplode() (OIDs), never by splitting
-- the aclitem text, so a quoted role name cannot shift the parse. Privilege
-- checks are EFFECTIVE: a privilege reached through role membership (INHERIT)
-- counts, and every role whose name starts with app_ is inspected, group AND
-- login roles, so a privilege held directly by a login identity cannot hide.
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
expected_triggers(tbl, trg, fn, tgtype, arg) AS (
  -- tgtype bits: ROW=1 BEFORE=2 INS=4 DEL=8 UPD=16 TRUNC=32
  --   27 = row, before, upd|del     34 = statement, before, trunc
  --    7 = row, before, ins         31 = row, before, ins|upd|del
  VALUES
    ('BillingAuditEvent',        'secf_append_only',      'secf_append_only_guard',          27, NULL),
    ('BillingAuditEvent',        'secf_no_truncate',      'secf_truncate_guard',             34, 'audit'),
    ('BillingAuditEvent',        'secf_chain_link',       'secf_audit_chain_link_guard',      7, NULL),
    ('PaymentAuditEvent',        'secf_append_only',      'secf_append_only_guard',          27, NULL),
    ('PaymentAuditEvent',        'secf_no_truncate',      'secf_truncate_guard',             34, 'audit'),
    ('PaymentAuditEvent',        'secf_chain_link',       'secf_audit_chain_link_guard',      7, NULL),
    ('PayablesAuditEvent',       'secf_append_only',      'secf_append_only_guard',          27, NULL),
    ('PayablesAuditEvent',       'secf_no_truncate',      'secf_truncate_guard',             34, 'audit'),
    ('PayablesAuditEvent',       'secf_chain_link',       'secf_audit_chain_link_guard',      7, NULL),
    ('SecurityEvent',            'secf_append_only',      'secf_append_only_guard',          27, NULL),
    ('SecurityEvent',            'secf_no_truncate',      'secf_truncate_guard',             34, 'audit'),
    ('BillingDocument',          'secf_fiscal_immutable', 'secf_billing_document_immutable', 27, NULL),
    ('BillingDocument',          'secf_no_truncate',      'secf_truncate_guard',             34, 'fiscal'),
    ('BillingDocumentLine',      'secf_fiscal_immutable', 'secf_billing_child_immutable',    31, 'billingDocumentId'),
    ('BillingDocumentLine',      'secf_no_truncate',      'secf_truncate_guard',             34, 'fiscal'),
    ('BillingReceiptPayment',    'secf_fiscal_immutable', 'secf_billing_child_immutable',    31, 'billingDocumentId'),
    ('BillingReceiptPayment',    'secf_no_truncate',      'secf_truncate_guard',             34, 'fiscal'),
    ('BillingPaymentAllocation', 'secf_fiscal_immutable', 'secf_billing_child_immutable',    31, 'receiptDocumentId'),
    ('BillingPaymentAllocation', 'secf_no_truncate',      'secf_truncate_guard',             34, 'fiscal')
),
actual_triggers AS (
  -- A trigger only counts if it fires unconditionally: enabled in origin mode
  -- ('O'), no WHEN clause, no column list, and exactly the expected argument.
  SELECT c.relname AS tbl, t.tgname AS trg, p.proname AS fn, t.tgtype::int AS tgtype,
         CASE WHEN t.tgnargs = 0 THEN NULL
              ELSE convert_from(substring(t.tgargs FROM 1 FOR position('\x00'::bytea IN t.tgargs) - 1), 'UTF8')
         END AS arg,
         t.tgnargs,
         (t.tgenabled = 'O' AND t.tgqual IS NULL AND coalesce(array_length(t.tgattr::int2[], 1), 0) = 0) AS fires
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND t.tgname LIKE 'secf\_%'
),
trigger_match AS (
  SELECT e.tbl, e.trg, a.trg IS NOT NULL AS ok
  FROM expected_triggers e
  LEFT JOIN actual_triggers a
    ON a.tbl = e.tbl AND a.trg = e.trg AND a.fn = e.fn AND a.tgtype = e.tgtype
   AND a.fires AND a.tgnargs = (CASE WHEN e.arg IS NULL THEN 0 ELSE 1 END)
   AND a.arg IS NOT DISTINCT FROM e.arg
),
expected_fn(fn, body_md5) AS (
  VALUES
    ('secf_append_only_guard',          'b19107a4a3df47fa95ffe8e5a5c799a1'),
    ('secf_audit_chain_link_guard',     'bed06accae7bc1d845e0949083cdd7d9'),
    ('secf_billing_document_immutable', '206ee4cb4d1f80c5f3007e4acd5365f2'),
    ('secf_billing_child_immutable',    '77f35992800456e1b70f63846743dded'),
    ('secf_truncate_guard',             'cfd14c768caaa0f9d0709b57a97834f0')
),
fn_match AS (
  -- Body byte-identical, exactly one function of that name in public, not
  -- SECURITY DEFINER, search_path pinned, and PUBLIC holds no EXECUTE.
  SELECT e.fn,
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
           WHERE p.proname = e.fn) = 1
         AND EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
            WHERE p.proname = e.fn
              AND md5(p.prosrc) = e.body_md5
              AND NOT p.prosecdef
              AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
              AND p.proacl IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0)
         ) AS ok
  FROM expected_fn e
),
audit_tables(tbl) AS (
  VALUES ('BillingAuditEvent'), ('PaymentAuditEvent'), ('PayablesAuditEvent')
),
acl AS (
  -- One row per aclitem. grantee_oid 0 = PUBLIC. privs = the privilege letters
  -- of that item (with '*' after a letter the grantee may pass on). A NULL relacl
  -- means the built-in default (owner only), made explicit with acldefault().
  SELECT c.relname AS tbl,
         g.grantee_oid,
         CASE WHEN g.grantee_oid = 0 THEN '' ELSE r.rolname END AS grantee,
         substring(item::text FROM '^(?:"(?:[^"]|"")*"|[^=]*)=([^/]*)/') AS privs
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL unnest(coalesce(c.relacl, acldefault('r', c.relowner))) AS item
  CROSS JOIN LATERAL (SELECT DISTINCT x.grantee AS grantee_oid FROM aclexplode(ARRAY[item]) x) g
  LEFT JOIN pg_roles r ON r.oid = g.grantee_oid
  WHERE c.relname IN ('BillingAuditEvent','PaymentAuditEvent','PayablesAuditEvent','SecurityEvent')
    AND c.relkind IN ('r','p')
),
app_roles AS (
  SELECT oid, rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'app\_%'
),
effective AS (
  -- (app_* role, table, privs) for every aclitem whose grantee the role holds
  -- the privileges of: itself, PUBLIC, or any role it inherits from.
  SELECT ar.rolname, a.tbl, a.grantee, a.privs
  FROM app_roles ar
  JOIN acl a ON a.grantee_oid = 0 OR pg_has_role(ar.oid, a.grantee_oid, 'USAGE')
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
expected_policies(tbl, pol, cmd, permissive, roles, qual_kind) AS (
  -- polcmd: r=SELECT a=INS w=UPD d=DEL *=ALL
  -- qual_kind: tenant = predicate reads app.current_business_id;
  --            none   = USING/WITH CHECK is exactly false (RESTRICTIVE deny);
  --            all    = USING (true) (platform admin read).
  VALUES
    ('BillingAuditEvent',  'secf_audit_insert',              'a', true,  'public',    'tenant'),
    ('BillingAuditEvent',  'secf_audit_no_update',           'w', false, 'public',    'none'),
    ('BillingAuditEvent',  'secf_audit_no_delete',           'd', false, 'public',    'none'),
    ('BillingAuditEvent',  'p7w4eb2_tenant',                 'r', true,  'public',    'tenant'),
    ('PaymentAuditEvent',  'secf_audit_insert',              'a', true,  'public',    'tenant'),
    ('PaymentAuditEvent',  'secf_audit_no_update',           'w', false, 'public',    'none'),
    ('PaymentAuditEvent',  'secf_audit_no_delete',           'd', false, 'public',    'none'),
    ('PaymentAuditEvent',  'p7w4ea_tenant',                  'r', true,  'public',    'tenant'),
    ('PayablesAuditEvent', 'secf_audit_insert',              'a', true,  'public',    'tenant'),
    ('PayablesAuditEvent', 'secf_audit_no_update',           'w', false, 'public',    'none'),
    ('PayablesAuditEvent', 'secf_audit_no_delete',           'd', false, 'public',    'none'),
    ('PayablesAuditEvent', 'payables_p1a_tenant',            'r', true,  'public',    'tenant'),
    ('SecurityEvent',      'secf_security_event_insert',     'a', true,  'public',    'tenant'),
    ('SecurityEvent',      'secf_security_event_admin_read', 'r', true,  'app_admin', 'all'),
    ('SecurityEvent',      'secf_audit_no_update',           'w', false, 'public',    'none'),
    ('SecurityEvent',      'secf_audit_no_delete',           'd', false, 'public',    'none')
),
actual_policies AS (
  SELECT c.relname AS tbl, pol.polname AS pol, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1)
            FROM unnest(pol.polroles) x) AS roles,
         CASE
           WHEN pg_get_expr(pol.polqual, pol.polrelid) = 'false' AND pol.polwithcheck IS NULL THEN 'none'
           WHEN pg_get_expr(pol.polqual, pol.polrelid) = 'true'  AND pol.polwithcheck IS NULL THEN 'all'
           WHEN position('app.current_business_id' IN
                  coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ||
                  coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) > 0 THEN 'tenant'
           ELSE 'other'
         END AS qual_kind
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN ('BillingAuditEvent','PaymentAuditEvent','PayablesAuditEvent','SecurityEvent')
),
checks(ord, check_name, ok, detail) AS (
  -- P1. Migration recorded as applied, finished, not rolled back.
  SELECT 1, 'P1 migration 20260926140000 recorded applied (finished, not rolled back)',
    EXISTS (SELECT 1 FROM _prisma_migrations
            WHERE migration_name = '20260926140000_sec_f_append_only_audit_fiscal_immutability_security_events'
              AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
    NULL::text
  UNION ALL
  -- P2. Exactly the 19 expected triggers: right table, function, event mask and
  -- argument, enabled, unconditional; and no unexpected secf_ trigger.
  SELECT 2, 'P2 all 19 secf_ triggers present, enabled, unconditional, bound to the expected function/events/argument',
    (SELECT count(*) FROM trigger_match WHERE ok) = 19
    AND (SELECT count(*) FROM actual_triggers) = 19,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || trg AS x FROM trigger_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.trg FROM actual_triggers a
        WHERE NOT EXISTS (SELECT 1 FROM expected_triggers e WHERE e.tbl = a.tbl AND e.trg = a.trg)) s)
  UNION ALL
  -- P3. Guard function bodies byte-identical to the reviewed migration, and the
  -- functions keep their shape (invoker rights, pinned search_path, no PUBLIC EXECUTE).
  SELECT 3, 'P3 guard functions match the reviewed migration (md5 prosrc, invoker, pinned search_path, no PUBLIC execute)',
    (SELECT count(*) FROM fn_match WHERE ok) = 5,
    (SELECT string_agg(fn, ',' ORDER BY fn) FROM fn_match WHERE NOT ok)
  UNION ALL
  -- P4. No app_* role (group or login) holds, directly or by inheritance,
  -- upd/del/trunc on an audit table.
  SELECT 4, 'P4 no app_* role holds w/d/D (direct or inherited) on the three audit tables',
    NOT EXISTS (SELECT 1 FROM effective WHERE tbl IN (SELECT tbl FROM audit_tables) AND privs ~ '[wdD]'),
    (SELECT string_agg(DISTINCT tbl || ':' || rolname || '<-' || CASE WHEN grantee = '' THEN 'PUBLIC' ELSE grantee END, ',')
       FROM effective WHERE tbl IN (SELECT tbl FROM audit_tables) AND privs ~ '[wdD]')
  UNION ALL
  -- P5. Normal operation kept: the runtime login still reads and appends audit rows
  -- (held by the app_runtime group or directly by the login).
  SELECT 5, 'P5 the runtime login keeps r+a (read, append) on the three audit tables',
    EXISTS (SELECT 1 FROM runtime_logins)
    AND NOT EXISTS (
      SELECT 1 FROM runtime_logins rl CROSS JOIN audit_tables t
       WHERE NOT EXISTS (SELECT 1 FROM acl a WHERE a.tbl = t.tbl AND a.privs ~ 'r'
                           AND (a.grantee_oid = 0 OR pg_has_role(rl.oid, a.grantee_oid, 'USAGE')))
          OR NOT EXISTS (SELECT 1 FROM acl a WHERE a.tbl = t.tbl AND a.privs ~ 'a'
                           AND (a.grantee_oid = 0 OR pg_has_role(rl.oid, a.grantee_oid, 'USAGE')))),
    (SELECT string_agg(rl.rolname || ':' || t.tbl, ',') FROM runtime_logins rl CROSS JOIN audit_tables t
      WHERE NOT EXISTS (SELECT 1 FROM acl a WHERE a.tbl = t.tbl AND a.privs ~ 'r'
                          AND (a.grantee_oid = 0 OR pg_has_role(rl.oid, a.grantee_oid, 'USAGE')))
         OR NOT EXISTS (SELECT 1 FROM acl a WHERE a.tbl = t.tbl AND a.privs ~ 'a'
                          AND (a.grantee_oid = 0 OR pg_has_role(rl.oid, a.grantee_oid, 'USAGE'))))
  UNION ALL
  -- P6. PUBLIC holds nothing on the audit tables or SecurityEvent.
  SELECT 6, 'P6 PUBLIC holds no privilege on audit tables or SecurityEvent',
    NOT EXISTS (SELECT 1 FROM acl WHERE grantee_oid = 0 AND privs <> ''),
    (SELECT string_agg(tbl, ',') FROM acl WHERE grantee_oid = 0 AND privs <> '')
  UNION ALL
  -- P7. Policy set exact: tenant rule narrowed to SELECT, append rule, RESTRICTIVE
  -- no-upd and no-del (USING false), admin-only SecurityEvent read, nothing else
  -- (in particular no FOR ALL rule) on these four tables.
  SELECT 7, 'P7 audit/SecurityEvent policies exact (select+append permissive, no-upd/no-del restrictive false, no FOR ALL, no extra)',
    (SELECT count(*) FROM expected_policies e JOIN actual_policies a
       USING (tbl, pol, cmd, permissive, roles, qual_kind)) = 16
    AND (SELECT count(*) FROM actual_policies) = 16,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.tbl || '.' || e.pol AS x FROM expected_policies e
        LEFT JOIN actual_policies a USING (tbl, pol, cmd, permissive, roles, qual_kind) WHERE a.pol IS NULL
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.pol FROM actual_policies a
        WHERE NOT EXISTS (SELECT 1 FROM expected_policies e WHERE e.tbl = a.tbl AND e.pol = a.pol)) s)
  UNION ALL
  -- P8. RLS enabled and forced on SecurityEvent and the three audit tables.
  SELECT 8, 'P8 RLS enabled+forced on SecurityEvent and the three audit tables',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN ('BillingAuditEvent','PaymentAuditEvent','PayablesAuditEvent','SecurityEvent')
         AND c.relrowsecurity AND c.relforcerowsecurity) = 4,
    (SELECT string_agg(t, ',') FROM unnest(ARRAY['BillingAuditEvent','PaymentAuditEvent','PayablesAuditEvent','SecurityEvent']) t
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                         WHERE c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity))
  UNION ALL
  -- P9. SecurityEvent direct privileges exact for app_* roles: app_runtime
  -- append-only, app_admin read-only, no other app_* role (login roles
  -- included) holds anything directly. Strict on purpose: a login role that
  -- the project's default privileges reach directly would show up here.
  SELECT 9, 'P9 SecurityEvent: app_runtime=a only, app_admin=r only, no other app_* privilege',
    EXISTS (SELECT 1 FROM acl WHERE tbl = 'SecurityEvent' AND grantee = 'app_runtime' AND privs = 'a')
    AND NOT EXISTS (SELECT 1 FROM acl WHERE tbl = 'SecurityEvent' AND grantee = 'app_runtime' AND privs <> 'a')
    AND EXISTS (SELECT 1 FROM acl WHERE tbl = 'SecurityEvent' AND grantee = 'app_admin' AND privs = 'r')
    AND NOT EXISTS (SELECT 1 FROM acl WHERE tbl = 'SecurityEvent' AND grantee = 'app_admin' AND privs <> 'r')
    AND NOT EXISTS (SELECT 1 FROM acl WHERE tbl = 'SecurityEvent' AND grantee LIKE 'app\_%'
                    AND grantee NOT IN ('app_runtime','app_admin') AND privs <> ''),
    (SELECT string_agg(grantee || '=' || privs, ',' ORDER BY grantee) FROM acl
      WHERE tbl = 'SecurityEvent' AND grantee LIKE 'app\_%')
  UNION ALL
  -- P10. PayablesAuditEvent -> Business foreign key is ON DEL RESTRICT.
  SELECT 10, 'P10 PayablesAuditEvent_businessId_fkey -> Business is ON DEL RESTRICT',
    EXISTS (SELECT 1 FROM pg_constraint k
              JOIN pg_class c ON c.oid = k.conrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
              JOIN pg_class p ON p.oid = k.confrelid
            WHERE c.relname = 'PayablesAuditEvent' AND k.conname = 'PayablesAuditEvent_businessId_fkey'
              AND p.relname = 'Business' AND k.contype = 'f' AND k.confdeltype = 'r' AND k.convalidated),
    (SELECT string_agg(k.conname || ':' || k.confdeltype::text, ',') FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE c.relname = 'PayablesAuditEvent' AND k.conname = 'PayablesAuditEvent_businessId_fkey')
  UNION ALL
  -- P11. Chain columns, chain-shape checks and the per-business chain uniqueness exist.
  SELECT 11, 'P11 chain columns + chain-shape checks + unique (businessId, chainSeq) on the three audit tables',
    (SELECT count(*) FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN (SELECT tbl FROM audit_tables)
         AND a.attname IN ('chainSeq','prevHash','chainHash','chainKeyId') AND NOT a.attisdropped) = 12
    AND (SELECT count(*) FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace AND n.nspname = 'public'
          WHERE ic.relname IN ('BillingAuditEvent_businessId_chainSeq_key','PaymentAuditEvent_businessId_chainSeq_key',
                               'PayablesAuditEvent_businessId_chainSeq_key')
            AND i.indisunique AND i.indisvalid) = 3
    AND (SELECT count(*) FROM pg_constraint k
          WHERE k.contype = 'c' AND k.convalidated
            AND k.conname IN ('BillingAuditEvent_chain_shape_chk','PaymentAuditEvent_chain_shape_chk',
                              'PayablesAuditEvent_chain_shape_chk')) = 3,
    NULL
  UNION ALL
  -- P12. The runtime identity cannot bypass these guards by role attributes
  -- (RLS needs NOBYPASSRLS; a superuser could switch triggers off). Covers every
  -- app_* role and every LOGIN role that inherits app_runtime, and requires the
  -- runtime login to exist.
  SELECT 12, 'P12 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS',
    NOT EXISTS (SELECT 1 FROM app_roles WHERE rolsuper OR rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM runtime_logins WHERE rolsuper OR rolbypassrls)
    AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(DISTINCT rolname, ',') FROM (
       SELECT rolname FROM app_roles WHERE rolsuper OR rolbypassrls
       UNION ALL SELECT rolname FROM runtime_logins WHERE rolsuper OR rolbypassrls) s)
)
SELECT ord,
       check_name,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       CASE WHEN ok THEN NULL ELSE detail END AS detail
FROM checks
ORDER BY ord;

ROLLBACK;
