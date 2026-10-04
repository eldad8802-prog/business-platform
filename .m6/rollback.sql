-- M6 PR-A rollback — 20261008090000_m6_acquisition_connections.
--
-- OWNER-RUN ONLY, never by the app, never by a workflow without a separate owner decision.
-- Proven in the lab (m6-acquisition-lab.yml): afterwards the preflight is whole again.
--
-- SAFE ONLY WHILE NOTHING USES IT: refuses if any connection exists or any business was given one of
-- the three features — a rollback never erases an owner's connections or decisions.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "AcquisitionConnection") THEN
    RAISE EXCEPTION 'M6 rollback refused: acquisition connections exist — inspect before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "BusinessFeatureAccess"
              WHERE "featureKey" IN ('acquisition_meta_lead_ads', 'acquisition_google_lead_forms', 'acquisition_web_forms')) THEN
    RAISE EXCEPTION 'M6 rollback refused: a business holds an acquisition feature override';
  END IF;
END
$guard$;
DROP FUNCTION public.m6_acquisition_resolve_keyed(text, text, text);
DROP FUNCTION public.m6_acquisition_resolve_public(text, text);
DROP FUNCTION public.m6_acquisition_resolve_resource(text, text);
DROP FUNCTION public.m6_acquisition_tenants(text);
DROP TABLE "AcquisitionConnection";
DELETE FROM "PlatformFeaturePolicy"
 WHERE "featureKey" IN ('acquisition_meta_lead_ads', 'acquisition_google_lead_forms', 'acquisition_web_forms');
DELETE FROM "PlatformFeatureDefinition"
 WHERE "key" IN ('acquisition_meta_lead_ads', 'acquisition_google_lead_forms', 'acquisition_web_forms');
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008090000_m6_acquisition_connections';
COMMIT;
