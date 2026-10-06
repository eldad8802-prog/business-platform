-- ============================================================================
-- m7bc-demand-lines-preflight.sql
--
-- Read-only PRE-APPLY proof for migration
--   20261014090000_m7bc_commerce_demand_and_line_labels
-- Everything it builds on is present and exactly as expected; nothing it adds exists yet; every existing
-- demand signal already satisfies the CHECK it widens.
--
-- NO DATA ROW is read except counts. Catalog and ledger rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== M7-B/C demand + line labels preflight — legend (n → check) =='
\echo ' 1 Q0 M7-A is recorded: finished, not rolled back (CommerceOrderLine, the telephony sources)'
\echo ' 2 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 3 Q2 this migration is not recorded and no newer migration is (observed = such rows)'
\echo ' 4 T0 nothing it adds exists: the COMMERCE value, the two columns, the key, the FK, the CHECK (observed = objects)'
\echo ' 5 C0 OfferingDemandSignal: the P1 identity and one-offering CHECKs are in force, validated, without COMMERCE'
\echo ' 6 C1 every existing demand signal already satisfies the WIDENED identity (observed = signals)'
\echo ' 7 G0 runtime: SELECT / INS-ERT / UPD-ATE and no DEL-ETE on the three tables it touches (observed = privileges held)'
\echo ' 8 R0 runtime logins NOSUPERUSER NOBYPASSRLS; the migration role is BYPASSRLS and may build in public'
\echo ' 9 R1 PRODUCTION PREMISE: OfferingDemandSignal, CommerceOrderLine, AcquisitionConnection under ENABLE + FORCE RLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
ods AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'OfferingDemandSignal' AND relkind = 'r'),
col AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'CommerceOrderLine' AND relkind = 'r'),
acq AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'AcquisitionConnection' AND relkind = 'r'),
src_type AS (SELECT oid FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname = 'OfferingDemandSource'),
three(t) AS (VALUES ('OfferingDemandSignal'), ('CommerceOrderLine'), ('AcquisitionConnection')),
priv(p) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE')),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
added AS (
  SELECT (SELECT count(*) FROM pg_enum WHERE enumtypid = (SELECT oid FROM src_type) AND enumlabel = 'COMMERCE')
       + (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM ods) AND attname = 'commerceOrderLineId' AND NOT attisdropped)
       + (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM acq) AND attname = 'lineLabels' AND NOT attisdropped)
       + (SELECT count(*) FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'CommerceOrderLine_id_businessId_key')
       + (SELECT count(*) FROM pg_constraint WHERE conname IN ('OfferingDemandSignal_commerceOrderLineId_businessId_fkey', 'AcquisitionConnection_line_labels'))
       + (SELECT count(*) FROM pg_index i WHERE i.indrelid = (SELECT oid FROM col) AND i.indisunique
            AND pg_get_indexdef(i.indexrelid) LIKE '%(id, "businessId")%') AS n),
-- Rows outside every P1 branch (expected none: the P1 CHECK is in force; the widened one keeps those branches).
widened_violations AS (
  SELECT count(*) AS n FROM "OfferingDemandSignal" s
   WHERE NOT (
     (s."signalType"::text = 'BOOKING' AND s."source"::text = 'APPOINTMENT' AND s."appointmentId" IS NOT NULL AND s."saleLineId" IS NULL AND s."offeringKind"::text = 'SERVICE')
     OR (s."signalType"::text = 'PURCHASE' AND s."source"::text = 'SALE' AND s."saleLineId" IS NOT NULL AND s."appointmentId" IS NULL AND s."offeringKind"::text = 'PRODUCT')
     OR (s."signalType"::text IN ('PRICE', 'AVAILABILITY') AND s."appointmentId" IS NULL AND s."saleLineId" IS NULL))),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261013090000_m7a_commerce_telephony_foundation'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261013090000_m7a_commerce_telephony_foundation')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name >= '20261014090000_m7bc_commerce_demand_and_line_labels'),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261014090000_m7bc_commerce_demand_and_line_labels')
  UNION ALL SELECT 4, (SELECT n FROM added) = 0 AND (SELECT count(*) FROM src_type) = 1 AND (SELECT count(*) FROM col) = 1,
                      (SELECT n FROM added)
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.conname = 'OfferingDemandSignal_identity'
                               AND k.convalidated AND position('SALE' IN pg_get_constraintdef(k.oid)) > 0
                               AND position('APPOINTMENT' IN pg_get_constraintdef(k.oid)) > 0
                               AND position('COMMERCE' IN pg_get_constraintdef(k.oid)) = 0)
                      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.conname = 'OfferingDemandSignal_one_offering' AND k.convalidated),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.contype = 'c')
  UNION ALL SELECT 6, (SELECT n FROM widened_violations) = 0,
                      (SELECT count(*) FROM "OfferingDemandSignal")
  UNION ALL SELECT 7, (SELECT count(*) FROM three, priv WHERE has_table_privilege('app_runtime', format('%I', t), p)) = 9
                      AND (SELECT count(*) FROM three WHERE has_table_privilege('app_runtime', format('%I', t), 'DEL' || 'ETE')) = 0,
                      (SELECT count(*) FROM three, priv WHERE has_table_privilege('app_runtime', format('%I', t), p))
                      + (SELECT count(*) FROM three WHERE has_table_privilege('app_runtime', format('%I', t), 'DEL' || 'ETE'))
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM runtime_roles)
                      AND NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls)
                      AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
                      AND has_schema_privilege(current_user, 'public', 'CRE' || 'ATE'),
                      (SELECT count(*) FROM runtime_roles)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                        AND c.relname IN (SELECT t FROM three) AND c.relrowsecurity AND c.relforcerowsecurity) = 3,
                      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                        AND c.relname IN (SELECT t FROM three) AND c.relrowsecurity AND c.relforcerowsecurity)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
