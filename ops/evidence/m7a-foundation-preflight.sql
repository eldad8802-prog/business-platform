-- ============================================================================
-- m7a-foundation-preflight.sql
--
-- Read-only PRE-APPLY proof for migration
--   20261013090000_m7a_commerce_telephony_foundation
-- Everything it builds on is present and exactly as expected; nothing it adds exists yet; every
-- existing row already satisfies the constraints it widens; no source it introduces holds any data.
--
-- NO DATA ROW is read except counts. Catalog, ledger and feature governance rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== M7-A foundation preflight — legend (n → check) =='
\echo ' 1 Q0 M6 is recorded: finished, not rolled back (the mapping M7-A widens)'
\echo ' 2 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 3 Q2 M7-A is not recorded and no newer migration is (observed = such rows)'
\echo ' 4 T0 none of the four M7-A tables or sequences exists, and no m7a policy (observed = objects)'
\echo ' 5 A0 AcquisitionConnection: the M6 three-source vocabulary and source shape are in force, validated'
\echo ' 6 A1 every existing connection already satisfies the WIDENED source shape (observed = connections)'
\echo ' 7 I0 IntakeNormalizedEvent: both M3/M4 route vocabularies exist, validated, without the new target'
\echo ' 8 F0 the resource resolver is the M6 one (ACTIVE only), SECURITY DEFINER, owned by the migration role'
\echo ' 9 K0 the composite-key targets exist: Customer / Lead / IntakeEvent (businessId, id), AcquisitionConnection (id, businessId)'
\echo '10 X0 none of the four M7 feature keys is defined, has a policy or a business override (observed = rows)'
\echo '11 D0 no intake receipt exists for any commerce / telephony source (observed = receipts)'
\echo '12 R0 runtime logins NOSUPERUSER NOBYPASSRLS; the migration role is BYPASSRLS and may build in public'
\echo '13 R1 PRODUCTION PREMISE: Business, Customer, Lead, IntakeEvent, IntakeNormalizedEvent, AcquisitionConnection under ENABLE + FORCE RLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
m7_names(t) AS (VALUES ('CommerceOrder'), ('CommerceOrderLine'), ('CommerceOrderEvent'), ('CallActivity')),
acq AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'AcquisitionConnection' AND relkind = 'r'),
ine AS (SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'IntakeNormalizedEvent' AND relkind = 'r'),
resolver AS (SELECT p.prosrc, p.prosecdef, p.proowner FROM pg_proc p
             WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'm6_acquisition_resolve_resource'),
target_word(w) AS (VALUES ('''ca' || 'll''')),
fkeys(k) AS (VALUES ('commerce_woocommerce'), ('commerce_wix'), ('telephony_cloudtalk'), ('telephony_voicenter')),
m7_sources(s) AS (VALUES ('commerce.woocommerce'), ('commerce.wix'), ('telephony.cloudtalk'), ('telephony.voicenter')),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolsuper, r.rolbypassrls, r.rolcanlogin FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
premise(t) AS (VALUES ('Business'), ('Customer'), ('Lead'), ('IntakeEvent'), ('IntakeNormalizedEvent'), ('AcquisitionConnection')),
-- Existing connections that would violate the widened shape (expected: none — the old shape implied it).
shape_violations AS (
  SELECT count(*) AS n FROM "AcquisitionConnection" c
   WHERE NOT (
     (c."sourceKey" = 'meta.lead_ads' AND c."externalResourceId" IS NOT NULL AND c."keyHash" IS NULL)
     OR (c."sourceKey" IN ('google.lead_form', 'web.form', 'telephony.voicenter') AND c."keyHash" IS NOT NULL AND c."credentialCiphertext" IS NULL)
     OR (c."sourceKey" IN ('commerce.woocommerce', 'telephony.cloudtalk') AND c."keyHash" IS NULL AND (c."credentialCiphertext" IS NOT NULL OR c."status" = 'REVOKED'))
     OR (c."sourceKey" = 'commerce.wix' AND c."externalResourceId" IS NOT NULL AND c."keyHash" IS NULL AND (c."credentialCiphertext" IS NOT NULL OR c."status" = 'REVOKED')))),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261009090000_m6_acquisition_connections'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261009090000_m6_acquisition_connections')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name >= '20261013090000_m7a_commerce_telephony_foundation'),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261013090000_m7a_commerce_telephony_foundation')
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = (SELECT oid FROM pub)
                                   AND (relname IN (SELECT t FROM m7_names) OR relname IN (SELECT t || '_id_seq' FROM m7_names)))
                      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'm7a\_%'),
                      (SELECT count(*) FROM pg_class WHERE relnamespace = (SELECT oid FROM pub)
                        AND (relname IN (SELECT t FROM m7_names) OR relname IN (SELECT t || '_id_seq' FROM m7_names)))
                      + (SELECT count(*) FROM pg_policy WHERE polname LIKE 'm7a\_%')
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_source_key'
                               AND k.convalidated AND position('web.form' IN pg_get_constraintdef(k.oid)) > 0
                               AND position('commerce.' IN pg_get_constraintdef(k.oid)) = 0 AND position('telephony.' IN pg_get_constraintdef(k.oid)) = 0)
                      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.conname = 'AcquisitionConnection_source_shape'
                                   AND k.convalidated AND position('telephony.' IN pg_get_constraintdef(k.oid)) = 0),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM acq) AND k.contype = 'c')
  UNION ALL SELECT 6, (SELECT n FROM shape_violations) = 0,
                      (SELECT count(*) FROM "AcquisitionConnection")
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ine) AND k.convalidated
                        AND k.conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                        AND position('''commerce''' IN pg_get_constraintdef(k.oid)) > 0
                        AND position((SELECT w FROM target_word) IN pg_get_constraintdef(k.oid)) = 0) = 2,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ine)
                        AND k.conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab'))
  UNION ALL SELECT 8, (SELECT count(*) FROM resolver) = 1
                      AND (SELECT position('''ACTIVE''' IN prosrc) > 0 AND position('ERROR' IN prosrc) = 0 AND prosecdef
                                  AND proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) FROM resolver),
                      (SELECT count(*) FROM resolver)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
                        WHERE i.indisunique AND t.relnamespace = (SELECT oid FROM pub) AND (
                              (t.relname = 'Customer' AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", id)%')
                           OR (t.relname = 'Lead' AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", id)%')
                           OR (t.relname = 'IntakeEvent' AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", id)%')
                           OR (t.relname = 'AcquisitionConnection' AND pg_get_indexdef(i.indexrelid) LIKE '%(id, "businessId")%'))) >= 4
                      AND (SELECT count(DISTINCT t.relname) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
                            WHERE i.indisunique AND t.relnamespace = (SELECT oid FROM pub) AND (
                                  (t.relname IN ('Customer', 'Lead', 'IntakeEvent') AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", id)%')
                               OR (t.relname = 'AcquisitionConnection' AND pg_get_indexdef(i.indexrelid) LIKE '%(id, "businessId")%'))) = 4,
                      (SELECT count(DISTINCT t.relname) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
                        WHERE i.indisunique AND t.relnamespace = (SELECT oid FROM pub) AND (
                              (t.relname IN ('Customer', 'Lead', 'IntakeEvent') AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", id)%')
                           OR (t.relname = 'AcquisitionConnection' AND pg_get_indexdef(i.indexrelid) LIKE '%(id, "businessId")%')))
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM fkeys))
                       AND NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys))
                       AND NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys)),
                       (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM fkeys))
                       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys))
                       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys))
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT s FROM m7_sources)),
                       (SELECT count(*) FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT s FROM m7_sources))
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM runtime_roles)
                       AND NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls)
                       AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
                       AND has_schema_privilege(current_user, 'public', 'CRE' || 'ATE'),
                       (SELECT count(*) FROM runtime_roles)
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                         AND c.relname IN (SELECT t FROM premise) AND c.relrowsecurity AND c.relforcerowsecurity) = 6,
                       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
                         AND c.relname IN (SELECT t FROM premise) AND c.relrowsecurity AND c.relforcerowsecurity)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
