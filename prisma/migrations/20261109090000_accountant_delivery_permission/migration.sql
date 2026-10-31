-- Accountant package — the per-business SEND permission (G5 M4)
--
-- WHAT THIS ADDS (two data rows; no table, column, constraint, role, grant, policy or function)
--   The feature flag `accountant_delivery`: whether a business may SEND its monthly accountant package from Dubiz.
--   It is separate from `accountant_month_close` (preparing, viewing and downloading the package), and it is OFF for
--   every business: defaultEnabled FALSE, globalEnabled FALSE. Only a platform admin can open it, per business, through
--   the existing feature-override path of the Admin Control Center (admin + MFA, every change in PlatformAuditEvent).
--   A business cannot open it for itself.
--
-- HOW IT IS USED (the application PR): every approval and every send attempt requires, at that moment, BOTH
--   1. this permission for the business, and
--   2. the global master switch ACCOUNTANT_DELIVERY_ENABLED (unchanged; off),
--   and every package still needs the owner's explicit approval. No automatic sending.
--
-- Additive, idempotent (ON CONFLICT DO NOTHING). Rollback: .acct/m4-rollback.sql (refuses while any override exists).

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('accountant_delivery', 'שליחת החבילה לרואה החשבון מתוך Dubiz', 'documents',
        'הרשאה לשלוח את החבילה החודשית לרואה החשבון מתוך Dubiz — כל משלוח עדיין באישור מפורש של בעל העסק', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('accountant_delivery', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
