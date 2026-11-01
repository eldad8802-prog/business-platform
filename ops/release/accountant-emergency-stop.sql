-- ============================================================================
-- accountant-emergency-stop.sql — STOP / RESUME all sending to accountants, at once, for every business.
--
-- WHO / WHERE: the owner, in the Neon SQL editor of project business-platform, Production branch (the database role
-- that owns the tables). Nothing to merge, migrate or deploy: the switch already exists
-- (PlatformFeaturePolicy.emergencyDisabled) and every deployment — including a browser tab pinned to an older one by
-- Vercel skew protection (up to 12 hours) — reads it from the database on every request; nothing caches it.
--
-- EFFECT OF STOP (accountant_delivery only):
--   * every approval answers 403 DELIVERY_NOT_PERMITTED; the owner's screen says sending is unavailable;
--   * a waiting approval (APPROVED) is CANCELED at its next attempt — never sent — with the reason in the trail;
--   * a send already in flight (SENDING) is never re-claimed; the provider call already running is not interrupted;
--   * NOT touched: preparing packages, notices, the owner's screens, the accountant's portal and links already sent.
-- To also close the whole workflow (preparation, notices, the portal: links answer 404), run the same statement with
-- featureKey 'accountant_month_close'.
--
-- Each block runs in one transaction and refuses unless exactly one row changes. Then confirm read-only with
-- ops/evidence/accountant-rollout-readiness.sql (check 12 = t while stopped, f after resume).
-- ============================================================================

-- ── STOP ────────────────────────────────────────────────────────────────────────────────────────
BEGIN;
UPDATE "PlatformFeaturePolicy"
   SET "emergencyDisabled" = true, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "featureKey" = 'accountant_delivery' AND "emergencyDisabled" = false;
-- Expect: UPDATE 1. Anything else → ROLLBACK and check.
SELECT "featureKey", "globalEnabled", "emergencyDisabled", "updatedAt" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery';
COMMIT;

-- ── RESUME (only on a decision to send again) ──────────────────────────────────────────────────
-- BEGIN;
-- UPDATE "PlatformFeaturePolicy"
--    SET "emergencyDisabled" = false, "updatedAt" = CURRENT_TIMESTAMP
--  WHERE "featureKey" = 'accountant_delivery' AND "emergencyDisabled" = true;
-- -- Expect: UPDATE 1.
-- COMMIT;
