-- Activity packs — rollback of 20261216090000_activity_packs (lab proof that the migration is purely additive).
-- Drops exactly what the migration created; nothing else exists that depends on it.
\set ON_ERROR_STOP 1
DROP TABLE "BusinessActivityProfile";
DROP FUNCTION public.business_activity_profile_guard();
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs';
SELECT 'ROLLBACK_OK' AS result;
