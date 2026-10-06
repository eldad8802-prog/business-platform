-- Reversal of 20261012090000_closed_loop_recommendation_evidence. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code writes or reads the table (the code PR not deployed, or reverted first). Dropping the
-- table discards captured evidence; that is the deliberate meaning of reversal here (the evidence is a derived
-- record of what Dubiz saw, the domain truth it describes stays in the ledger). The append-only guard blocks
-- row deletes, not DROP TABLE. Then mark the migration rolled back: prisma migrate resolve --rolled-back <name>.

BEGIN;
DROP TABLE IF EXISTS "OutcomeRecommendationEvidence";
DELETE FROM "BusinessFeatureAccess" WHERE "featureKey" = 'owner_recommendations';
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'owner_recommendations';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'owner_recommendations';
COMMIT;
