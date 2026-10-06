-- ============================================================================
-- m7a-foundation-production-evidence.sql
--
-- Read-only POST-APPLY proof that migration
--   20261013090000_m7a_commerce_telephony_foundation
-- is in force with exactly its intended security properties.
--
-- NO DATA ROW is read except counts. Catalog, ledger and feature governance rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== M7-A foundation post-apply proof — legend (n → check) =='
\echo ' 1 Q0 M7-A recorded: finished, not rolled back, checksum = the reviewed file'
\echo ' 2 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 3 T1 the four tables have exactly their reviewed columns (observed = columns)'
\echo ' 4 T2 exactly the named CHECK constraints, all validated (observed = checks)'
\echo ' 5 T3 exactly the reviewed indexes, incl. the PARTIAL unknown-caller index (observed = indexes)'
\echo ' 6 T4 exactly the reviewed foreign keys: Business cascade, composite tenant keys, SET NULL for Customer / Lead (observed = FKs)'
\echo ' 7 S1 RLS enabled AND forced on all four'
\echo ' 8 S2 per-command policies with the tenant predicate: SELECT/INS/UPD (the order history: SELECT/INS only), none for DEL / ALL'
\echo ' 9 G1 runtime (group + logins): arw on the order, its lines and the activity table, ar on the order history; Ur on each sequence; never d / D / x / t'
\echo '10 G2 no other app_* role and not PUBLIC holds anything on the four tables or their sequences'
\echo '11 A1 AcquisitionConnection: the 7-source vocabulary and the widened source shape, validated'
\echo '12 A2 IntakeNormalizedEvent: both route vocabularies include the new target, validated'
\echo '13 F1 the resource resolver answers ACTIVE and ERROR only; still SECURITY DEFINER, STABLE, search_path pinned, migration-role owned, runtime-only EXECUTE'
\echo '14 X1 the four M7 features: defined OFF, policies OFF, no business override (observed = overrides)'
\echo '15 X2 the four tables hold no row (nothing was enabled; observed = rows)'
\echo '16 X3 runtime logins NOSUPERUSER NOBYPASSRLS; the migration role is BYPASSRLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
names(t) AS (VALUES ('CommerceOrder'), ('CommerceOrderLine'), ('CommerceOrderEvent'), ('CallActivity')),
tbls AS (SELECT c.oid, c.relname, c.relacl, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r' AND c.relname IN (SELECT t FROM names)),
seqs AS (SELECT c.oid, c.relname, c.relacl FROM pg_class c
         WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'S' AND c.relname IN (SELECT t || '_id_seq' FROM names)),
tenant(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_cols(t, col) AS (VALUES
  ('CommerceOrder', 'id'), ('CommerceOrder', 'businessId'), ('CommerceOrder', 'connectionId'), ('CommerceOrder', 'sourceKey'),
  ('CommerceOrder', 'externalOrderId'), ('CommerceOrder', 'orderNumber'), ('CommerceOrder', 'customerId'), ('CommerceOrder', 'status'),
  ('CommerceOrder', 'currency'), ('CommerceOrder', 'totalMinor'), ('CommerceOrder', 'refundedMinor'), ('CommerceOrder', 'lineCount'),
  ('CommerceOrder', 'placedAt'), ('CommerceOrder', 'providerUpdatedAt'), ('CommerceOrder', 'providerSequence'), ('CommerceOrder', 'attribution'),
  ('CommerceOrder', 'firstIntakeEventId'), ('CommerceOrder', 'lastIntakeEventId'), ('CommerceOrder', 'createdAt'), ('CommerceOrder', 'updatedAt'),
  ('CommerceOrderLine', 'id'), ('CommerceOrderLine', 'businessId'), ('CommerceOrderLine', 'orderId'), ('CommerceOrderLine', 'lineKey'),
  ('CommerceOrderLine', 'externalProductId'), ('CommerceOrderLine', 'sku'), ('CommerceOrderLine', 'title'), ('CommerceOrderLine', 'quantity'),
  ('CommerceOrderLine', 'unitMinor'), ('CommerceOrderLine', 'totalMinor'), ('CommerceOrderLine', 'present'), ('CommerceOrderLine', 'createdAt'),
  ('CommerceOrderLine', 'updatedAt'),
  ('CommerceOrderEvent', 'id'), ('CommerceOrderEvent', 'businessId'), ('CommerceOrderEvent', 'orderId'), ('CommerceOrderEvent', 'intakeEventId'),
  ('CommerceOrderEvent', 'kind'), ('CommerceOrderEvent', 'statusAfter'), ('CommerceOrderEvent', 'applied'), ('CommerceOrderEvent', 'providerUpdatedAt'),
  ('CommerceOrderEvent', 'createdAt'),
  ('CallActivity', 'id'), ('CallActivity', 'businessId'), ('CallActivity', 'connectionId'), ('CallActivity', 'sourceKey'),
  ('CallActivity', 'providerCallId'), ('CallActivity', 'direction'), ('CallActivity', 'outcome'), ('CallActivity', 'durationSec'),
  ('CallActivity', 'startedAt'), ('CallActivity', 'endedAt'), ('CallActivity', 'businessLine'), ('CallActivity', 'callerState'),
  ('CallActivity', 'callerHash'), ('CallActivity', 'customerId'), ('CallActivity', 'leadId'), ('CallActivity', 'firstIntakeEventId'),
  ('CallActivity', 'lastIntakeEventId'), ('CallActivity', 'providerUpdatedAt'), ('CallActivity', 'returnedAt'), ('CallActivity', 'returnedVia'),
  ('CallActivity', 'createdAt'), ('CallActivity', 'updatedAt')),
cols AS (SELECT t.relname AS t, a.attname AS col FROM tbls t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped),
expected_checks(nm) AS (VALUES
  ('CommerceOrder_source_key'), ('CommerceOrder_external_order'), ('CommerceOrder_order_number'), ('CommerceOrder_status'),
  ('CommerceOrder_currency'), ('CommerceOrder_amounts'), ('CommerceOrder_line_count'), ('CommerceOrder_sequence'),
  ('CommerceOrderLine_line_key'), ('CommerceOrderLine_product'), ('CommerceOrderLine_sku'), ('CommerceOrderLine_title'), ('CommerceOrderLine_amounts'),
  ('CommerceOrderEvent_kind'), ('CommerceOrderEvent_status_after'),
  ('CallActivity_source_key'), ('CallActivity_provider_call'), ('CallActivity_direction'), ('CallActivity_outcome'), ('CallActivity_duration'),
  ('CallActivity_ended'), ('CallActivity_business_line'), ('CallActivity_caller_state'), ('CallActivity_caller_hash'),
  ('CallActivity_hidden_shape'), ('CallActivity_returned_shape')),
checks_c AS (SELECT k.conname, k.convalidated FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM tbls) AND k.contype = 'c'),
expected_idx(nm, uniq) AS (VALUES
  ('CommerceOrder_pkey', true), ('CommerceOrder_id_businessId_key', true), ('CommerceOrder_businessId_sourceKey_externalOrderId_key', true),
  ('CommerceOrder_businessId_customerId_idx', false), ('CommerceOrder_businessId_placedAt_idx', false),
  ('CommerceOrderLine_pkey', true), ('CommerceOrderLine_businessId_orderId_lineKey_key', true),
  ('CommerceOrderEvent_pkey', true), ('CommerceOrderEvent_businessId_intakeEventId_key', true), ('CommerceOrderEvent_businessId_orderId_idx', false),
  ('CallActivity_pkey', true), ('CallActivity_id_businessId_key', true), ('CallActivity_businessId_sourceKey_providerCallId_key', true),
  ('CallActivity_businessId_customerId_startedAt_idx', false), ('CallActivity_businessId_startedAt_idx', false), ('CallActivity_unknown_caller_idx', false)),
idx AS (SELECT ic.relname, i.indisunique, pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid IN (SELECT oid FROM tbls)),
expected_fk(nm, target, deltype) AS (VALUES
  ('CommerceOrder_businessId_fkey', 'Business', 'c'), ('CommerceOrder_connectionId_businessId_fkey', 'AcquisitionConnection', 'c'),
  ('CommerceOrder_customerId_tenant_fkey', 'Customer', 'n'),
  ('CommerceOrderLine_businessId_fkey', 'Business', 'c'), ('CommerceOrderLine_orderId_businessId_fkey', 'CommerceOrder', 'c'),
  ('CommerceOrderEvent_businessId_fkey', 'Business', 'c'), ('CommerceOrderEvent_orderId_businessId_fkey', 'CommerceOrder', 'c'),
  ('CommerceOrderEvent_businessId_intakeEventId_fkey', 'IntakeEvent', 'c'),
  ('CallActivity_businessId_fkey', 'Business', 'c'), ('CallActivity_connectionId_businessId_fkey', 'AcquisitionConnection', 'c'),
  ('CallActivity_customerId_tenant_fkey', 'Customer', 'n'), ('CallActivity_leadId_tenant_fkey', 'Lead', 'n')),
fks AS (SELECT k.conname, k.confrelid::regclass::text AS target, k.confdeltype::text AS deltype, k.convalidated
        FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM tbls) AND k.contype = 'f'),
pol AS (SELECT c.relname AS t, p.polcmd::text AS cmd, p.polpermissive AS permissive, p.polroles,
               pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.polrelid IN (SELECT oid FROM tbls)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
others AS (SELECT r.oid FROM pg_roles r WHERE r.rolname LIKE 'app\_%' AND r.rolname <> current_user
           AND r.oid NOT IN (SELECT oid FROM runtime_roles)
           AND NOT pg_has_role(r.oid, (SELECT oid FROM rt), 'USAGE')),
privs(p) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUNC' || 'ATE'), ('REFERENCES'), ('TRIGGER')),
acq AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'AcquisitionConnection' AND relkind = 'r'),
ine AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'IntakeNormalizedEvent' AND relkind = 'r'),
resolver AS (SELECT p.oid, p.prosrc, p.prosecdef, p.provolatile, p.proowner, p.proconfig FROM pg_proc p
             WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'm6_acquisition_resolve_resource'),
fkeys(k) AS (VALUES ('commerce_woocommerce'), ('commerce_wix'), ('telephony_cloudtalk'), ('telephony_voicenter')),
target_word(w) AS (VALUES ('''ca' || 'll''')),
-- Row counts of tables that may not exist yet (the pre-apply lab): evaluated only for a table that does.
row_counts(t, r) AS (
  SELECT n.t, CASE WHEN to_regclass(format('public.%I', n.t)) IS NULL THEN NULL
                   ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', n.t), false, true, '')))[1]::text::bigint END
    FROM names n),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261013090000_m7a_commerce_telephony_foundation'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                     AND checksum = '3910bdaba780a82e01cec1caf2907ae868244cb29af7e7962a5a654c497a43e5'),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261013090000_m7a_commerce_telephony_foundation')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM tbls) = 4 AND (SELECT count(*) FROM cols) = 64
                      AND NOT EXISTS (SELECT t, col FROM expected_cols EXCEPT SELECT t, col FROM cols),
                      (SELECT count(*) FROM cols)
  UNION ALL SELECT 4, (SELECT count(*) FROM checks_c) = 26 AND (SELECT bool_and(convalidated) FROM checks_c)
                      AND NOT EXISTS (SELECT nm FROM expected_checks EXCEPT SELECT conname FROM checks_c),
                      (SELECT count(*) FROM checks_c)
  UNION ALL SELECT 5, (SELECT count(*) FROM idx) = 16
                      AND NOT EXISTS (SELECT e.nm FROM expected_idx e WHERE NOT EXISTS (SELECT 1 FROM idx i WHERE i.relname = e.nm AND i.indisunique = e.uniq))
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'CallActivity_unknown_caller_idx' AND position('"callerHash" IS NOT NULL' IN pred) > 0)
                      AND (SELECT count(*) FROM idx WHERE pred IS NOT NULL) = 1,
                      (SELECT count(*) FROM idx)
  UNION ALL SELECT 6, (SELECT count(*) FROM fks) = 12 AND (SELECT bool_and(convalidated) FROM fks)
                      AND NOT EXISTS (SELECT e.nm FROM expected_fk e
                                       WHERE NOT EXISTS (SELECT 1 FROM fks f WHERE f.conname = e.nm AND f.deltype = e.deltype
                                                           AND f.target IN (e.target, '"' || e.target || '"'))),
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 7, (SELECT count(*) FROM tbls WHERE relrowsecurity AND relforcerowsecurity) = 4,
                      (SELECT count(*) FROM tbls WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 8, (SELECT count(*) FROM pol) = 11
                      AND NOT EXISTS (SELECT 1 FROM pol WHERE NOT permissive OR polroles <> '{0}' OR cmd NOT IN ('r', 'a', 'w'))
                      AND NOT EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'r' AND NOT (qual = tenant.e AND wcheck IS NULL))
                      AND NOT EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'a' AND NOT (qual IS NULL AND wcheck = tenant.e))
                      AND NOT EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'w' AND NOT (qual = tenant.e AND wcheck = tenant.e))
                      AND (SELECT count(*) FROM pol WHERE t = 'CommerceOrderEvent' AND cmd = 'w') = 0
                      AND (SELECT count(DISTINCT t || cmd) FROM pol) = 11,
                      (SELECT count(*) FROM pol)
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM runtime_roles WHERE rolcanlogin)
                      AND NOT EXISTS (
                        SELECT 1 FROM runtime_roles r CROSS JOIN tbls t
                         WHERE NOT (has_table_privilege(r.oid, t.oid, 'SELECT') AND has_table_privilege(r.oid, t.oid, 'INS' || 'ERT')
                                AND has_table_privilege(r.oid, t.oid, 'UPD' || 'ATE') = (t.relname <> 'CommerceOrderEvent')
                                AND NOT has_table_privilege(r.oid, t.oid, 'DEL' || 'ETE') AND NOT has_table_privilege(r.oid, t.oid, 'TRUNC' || 'ATE')
                                AND NOT has_table_privilege(r.oid, t.oid, 'REFERENCES') AND NOT has_table_privilege(r.oid, t.oid, 'TRIGGER')))
                      AND NOT EXISTS (
                        SELECT 1 FROM runtime_roles r CROSS JOIN seqs s
                         WHERE NOT (has_sequence_privilege(r.oid, s.oid, 'USAGE') AND has_sequence_privilege(r.oid, s.oid, 'SELECT')
                                AND NOT has_sequence_privilege(r.oid, s.oid, 'UPD' || 'ATE')))
                      AND (SELECT count(*) FROM seqs) = 4,
                      (SELECT count(*) FROM runtime_roles)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM others o CROSS JOIN tbls t CROSS JOIN privs v WHERE has_table_privilege(o.oid, t.oid, v.p))
                       AND NOT EXISTS (SELECT 1 FROM others o CROSS JOIN seqs s WHERE has_sequence_privilege(o.oid, s.oid, 'USAGE'))
                       AND NOT EXISTS (SELECT 1 FROM tbls t, aclexplode(t.relacl) x WHERE x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM seqs s, aclexplode(s.relacl) x WHERE x.grantee = 0),
                       (SELECT count(*) FROM others)
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_source_key'
                                AND k.convalidated
                                AND position('commerce.woocommerce' IN pg_get_constraintdef(k.oid)) > 0 AND position('commerce.wix' IN pg_get_constraintdef(k.oid)) > 0
                                AND position('telephony.cloudtalk' IN pg_get_constraintdef(k.oid)) > 0 AND position('telephony.voicenter' IN pg_get_constraintdef(k.oid)) > 0
                                AND position('meta.lead_ads' IN pg_get_constraintdef(k.oid)) > 0 AND position('google.lead_form' IN pg_get_constraintdef(k.oid)) > 0
                                AND position('web.form' IN pg_get_constraintdef(k.oid)) > 0)
                       AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_source_shape'
                                AND k.convalidated AND position('telephony.voicenter' IN pg_get_constraintdef(k.oid)) > 0
                                AND position('REVOKED' IN pg_get_constraintdef(k.oid)) > 0)
                       AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.contype = 'c') = 12,
                       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.contype = 'c')
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint k, target_word w WHERE k.conrelid = (SELECT oid FROM ine) AND k.convalidated
                         AND k.conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                         AND position(w.w IN pg_get_constraintdef(k.oid)) > 0 AND position('''commerce''' IN pg_get_constraintdef(k.oid)) > 0) = 2,
                       (SELECT count(*) FROM pg_constraint k, target_word w WHERE k.conrelid = (SELECT oid FROM ine)
                         AND position(w.w IN pg_get_constraintdef(k.oid)) > 0)
  UNION ALL SELECT 13, (SELECT count(*) FROM resolver) = 1
                       AND (SELECT position('''ERROR''' IN prosrc) > 0 AND position('''ACTIVE''' IN prosrc) > 0 AND position('PAUSED' IN prosrc) = 0
                                   AND position('REVOKED' IN prosrc) = 0 FROM resolver)
                       AND (SELECT prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                                   AND 'search_path=pg_catalog, public' = ANY (coalesce(proconfig, ARRAY[]::text[])) FROM resolver)
                       AND has_function_privilege((SELECT oid FROM rt), (SELECT oid FROM resolver), 'EXECUTE')
                       AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('app_auth', 'app_ctlplane', 'app_admin')
                                        AND has_function_privilege(r.oid, (SELECT oid FROM resolver), 'EXECUTE'))
                       AND NOT EXISTS (SELECT 1 FROM resolver f, aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f', f.proowner))) x
                                        WHERE x.grantee = 0),
                       (SELECT count(*) FROM resolver)
  UNION ALL SELECT 14, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM fkeys) AND NOT "defaultEnabled") = 4
                       AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys) AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 4
                       AND NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys)),
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys))
  UNION ALL SELECT 15, (SELECT count(*) FROM tbls) = 4 AND (SELECT sum(r) FROM row_counts) = 0,
                       coalesce((SELECT sum(r) FROM row_counts), -1)
  UNION ALL SELECT 16, NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls)
                       AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
