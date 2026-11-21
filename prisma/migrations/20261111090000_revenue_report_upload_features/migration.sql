-- Revenue report uploads (Z reports, card settlement reports) — the two feature rows, OFF.
--
-- Data only: one PlatformFeatureDefinition row and its PlatformFeaturePolicy row for each of `z_report_upload` and
-- `settlement_report_upload`, all OFF (defaultEnabled false, globalEnabled false). The catalog in code
-- (lib/services/feature-access/platform-feature-catalog.ts) says the same, so a deploy that reaches Production before
-- this migration is OFF too. A feature opens only through a deliberate per-business override (BusinessFeatureAccess)
-- or a later, separately approved rollout. docs/revenue-report-uploads.md
-- No schema, no privilege, no policy change; nothing else is touched. Re-running it changes nothing.
--
-- ROLLBACK (only while no BusinessFeatureAccess row names these keys; check first):
--   SELECT "businessId", "featureKey", "state" FROM "BusinessFeatureAccess"
--    WHERE "featureKey" IN ('z_report_upload', 'settlement_report_upload');
--   DELETE FROM "PlatformFeaturePolicy"     WHERE "featureKey" IN ('z_report_upload', 'settlement_report_upload');
--   DELETE FROM "PlatformFeatureDefinition" WHERE "key"        IN ('z_report_upload', 'settlement_report_upload');
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261111090000_revenue_report_upload_features';
-- With the rows gone the resolver falls back to the catalog default (OFF): removing them never opens anything.

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('z_report_upload', 'העלאת דוחות Z', 'revenue',
        'העלאת דוח Z (סגירת קופה יומית) עם בדיקה לפני קליטה, לשכבת אמת ההכנסות — דוח בלבד, לא רישום הכנסה — כבוי כברירת מחדל',
        false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('settlement_report_upload', 'העלאת דוחות סליקה', 'revenue',
        'העלאת דוח סליקה מחברת האשראי (ברוטו, עמלות, נטו) עם בדיקה לפני קליטה, לשכבת אמת ההכנסות — דוח בלבד — כבוי כברירת מחדל',
        false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('z_report_upload', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('settlement_report_upload', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
