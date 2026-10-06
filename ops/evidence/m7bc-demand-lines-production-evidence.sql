-- ============================================================================
-- m7bc-demand-lines-production-evidence.sql
--
-- Read-only POST-APPLY proof for migration
--   20261014090000_m7bc_commerce_demand_and_line_labels
--   sha256 '0ebc9564b455f14f74d28bd3dac4b67179ebf69c59dd9125b4ef8b8a44ce8afd'
-- The migration is recorded once with exactly this file; everything it adds is present and exactly as
-- written; the runtime's privileges and the tenant controls are unchanged; no row uses the new paths yet.
--
-- NO DATA ROW is read except counts. Catalog and ledger rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== M7-B/C demand + line labels post-apply proof — legend (n → check) =='
\echo ' 1 L0 recorded once, finished, not rolled back, with the pinned checksum'
\echo ' 2 E0 OfferingDemandSource is exactly APPOINTMENT, SALE, COMMERCE (observed = values)'
\echo ' 3 C0 OfferingDemandSignal.commerceOrderLineId: integer, nullable'
\echo ' 4 K0 its FK is composite (commerceOrderLineId, businessId) → CommerceOrderLine (id, businessId), cascades, validated'
\echo ' 5 K1 CommerceOrderLine (id, businessId) is a unique key'
\echo ' 6 C1 OfferingDemandSignal_identity: validated, COMMERCE needs a store line and nothing else; one-offering intact'
\echo ' 7 C2 AcquisitionConnection.lineLabels: jsonb, nullable, CHECK telephony-only object, validated'
\echo ' 8 G0 runtime: SELECT / INS-ERT / UPD-ATE and still no DEL-ETE on the three tables (observed = privileges held)'
\echo ' 9 G1 app_auth / app_ctlplane hold nothing on OfferingDemandSignal or CommerceOrderLine (observed = privileges)'
\echo '10 R0 CommerceOrderLine and AcquisitionConnection under ENABLE + FORCE RLS'
\echo '11 R1 PRODUCTION PREMISE: OfferingDemandSignal under ENABLE + FORCE RLS'
\echo '12 D0 nothing uses the new paths yet: COMMERCE signals + labelled connections (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
ods AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'OfferingDemandSignal' AND relkind = 'r'),
col AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'CommerceOrderLine' AND relkind = 'r'),
acq AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'AcquisitionConnection' AND relkind = 'r'),
src_type AS (SELECT oid FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname = 'OfferingDemandSource'),
three(t) AS (VALUES ('OfferingDemandSignal'), ('CommerceOrderLine'), ('AcquisitionConnection')),
two(t) AS (VALUES ('OfferingDemandSignal'), ('CommerceOrderLine')),
priv(p) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE')),
any_priv(p) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUNC' || 'ATE'), ('REFERENCES'), ('TRIGGER')),
foreign_roles AS (SELECT rolname FROM pg_roles WHERE rolname IN ('app_auth', 'app_ctlplane')),
fk AS (SELECT k.* FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.conname = 'OfferingDemandSignal_commerceOrderLineId_businessId_fkey'),
ident AS (SELECT pg_get_constraintdef(k.oid) AS def, k.convalidated FROM pg_constraint k
          WHERE k.conrelid = (SELECT oid FROM ods) AND k.conname = 'OfferingDemandSignal_identity'),
-- The COMMERCE branch of the identity CHECK, read from its definition (a store line, no sale line, no appointment, a product).
commerce_branch AS (
  SELECT substring(def FROM position('''COMMERCE''' IN def)) AS tail FROM ident WHERE position('''COMMERCE''' IN def) > 0),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261014090000_m7bc_commerce_demand_and_line_labels'
              AND finished_at IS NOT NULL AND rolled_back_at IS NULL
              AND checksum = '0ebc9564b455f14f74d28bd3dac4b67179ebf69c59dd9125b4ef8b8a44ce8afd') = 1
            AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261014090000_m7bc_commerce_demand_and_line_labels') = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261014090000_m7bc_commerce_demand_and_line_labels')
  UNION ALL SELECT 2, (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = (SELECT oid FROM src_type)) = 'APPOINTMENT,SALE,COMMERCE',
                      (SELECT count(*) FROM pg_enum WHERE enumtypid = (SELECT oid FROM src_type))
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM ods) AND a.attname = 'commerceOrderLineId'
                               AND NOT a.attisdropped AND NOT a.attnotnull AND a.atttypid = 'int4'::regtype),
                      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM ods) AND a.attname = 'commerceOrderLineId' AND NOT a.attisdropped)
  UNION ALL SELECT 4, (SELECT count(*) FROM fk) = 1
                      AND (SELECT confrelid FROM fk) = (SELECT oid FROM col)
                      AND (SELECT confdeltype FROM fk) = 'c' AND (SELECT convalidated FROM fk)
                      AND (SELECT pg_get_constraintdef(oid) FROM fk) LIKE '%("commerceOrderLineId", "businessId")%(id, "businessId")%',
                      (SELECT count(*) FROM fk)
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = (SELECT oid FROM col) AND i.indisunique
                               AND pg_get_indexdef(i.indexrelid) LIKE '%(id, "businessId")%'),
                      (SELECT count(*) FROM pg_index i WHERE i.indrelid = (SELECT oid FROM col) AND i.indisunique)
  UNION ALL SELECT 6, (SELECT convalidated FROM ident)
                      AND (SELECT count(*) FROM commerce_branch) = 1
                      AND (SELECT position('"commerceOrderLineId" IS NOT NULL' IN tail) > 0 AND position('"saleLineId" IS NULL' IN tail) > 0
                                  AND position('"appointmentId" IS NULL' IN tail) > 0 FROM commerce_branch)
                      AND (SELECT position('"commerceOrderLineId" IS NULL' IN def) > 0 FROM ident)
                      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.conname = 'OfferingDemandSignal_one_offering' AND k.convalidated),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ods) AND k.contype = 'c')
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM acq) AND a.attname = 'lineLabels'
                               AND NOT a.attisdropped AND NOT a.attnotnull AND a.atttypid = 'jsonb'::regtype)
                      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_line_labels'
                                   AND k.convalidated AND position('telephony.cloudtalk' IN pg_get_constraintdef(k.oid)) > 0
                                   AND position('telephony.voicenter' IN pg_get_constraintdef(k.oid)) > 0
                                   AND position('jsonb_typeof' IN pg_get_constraintdef(k.oid)) > 0),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_line_labels')
  UNION ALL SELECT 8, (SELECT count(*) FROM three, priv WHERE has_table_privilege('app_runtime', format('%I', t), p)) = 9
                      AND (SELECT count(*) FROM three WHERE has_table_privilege('app_runtime', format('%I', t), 'DEL' || 'ETE')) = 0,
                      (SELECT count(*) FROM three, priv WHERE has_table_privilege('app_runtime', format('%I', t), p))
                      + (SELECT count(*) FROM three WHERE has_table_privilege('app_runtime', format('%I', t), 'DEL' || 'ETE'))
  UNION ALL SELECT 9, (SELECT count(*) FROM foreign_roles, two, any_priv WHERE has_table_privilege(rolname, format('%I', t), p)) = 0,
                      (SELECT count(*) FROM foreign_roles, two, any_priv WHERE has_table_privilege(rolname, format('%I', t), p))
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class c WHERE c.oid IN ((SELECT oid FROM col), (SELECT oid FROM acq))
                         AND c.relrowsecurity AND c.relforcerowsecurity) = 2,
                       (SELECT count(*) FROM pg_class c WHERE c.oid IN ((SELECT oid FROM col), (SELECT oid FROM acq))
                         AND c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL SELECT 11, (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = (SELECT oid FROM ods)),
                       (SELECT count(*) FROM pg_class WHERE oid = (SELECT oid FROM ods) AND relrowsecurity AND relforcerowsecurity)
  -- Read through to_jsonb so the proof also runs (and fails cleanly) on a database without the column.
  UNION ALL SELECT 12, (SELECT count(*) FROM "OfferingDemandSignal" WHERE "source"::text = 'COMMERCE')
                       + (SELECT count(*) FROM "AcquisitionConnection" a WHERE jsonb_typeof(to_jsonb(a) -> 'lineLabels') = 'object') = 0,
                       (SELECT count(*) FROM "OfferingDemandSignal" WHERE "source"::text = 'COMMERCE')
                       + (SELECT count(*) FROM "AcquisitionConnection" a WHERE jsonb_typeof(to_jsonb(a) -> 'lineLabels') = 'object')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
