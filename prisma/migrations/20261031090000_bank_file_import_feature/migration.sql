-- Bank file import (revenue truth milestone B1) — the feature row, OFF.
--
-- Data only: one PlatformFeatureDefinition row and its PlatformFeaturePolicy row for `bank_file_import`,
-- both OFF (defaultEnabled false, globalEnabled false). The catalog in code says the same, so a deploy that
-- reaches Production before this migration is OFF too. The feature opens only through a deliberate
-- per-business override (BusinessFeatureAccess) or a later, separately approved rollout.
-- No schema, no privilege, no policy change; nothing else is touched. Re-running it changes nothing.

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('bank_file_import', 'קליטת קובצי בנק', 'integrations',
        'העלאת קובץ תנועות בנק (CSV או Excel) עם תצוגה מקדימה לפני קליטה', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('bank_file_import', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
