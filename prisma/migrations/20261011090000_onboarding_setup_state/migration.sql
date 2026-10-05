-- ============================================================================
-- Onboarding setup state on BusinessProfile (M1)
--
-- A new business answers at most two short, skippable questions after signup
-- ("what does the business do", "what do you want to start with") and lands on
-- Home with a first action chosen from the second answer. The answers about the
-- business itself already have canonical homes (category / subCategory /
-- businessModel). What has no home is the setup state itself:
--
--   onboardingCompletedAt  — the owner finished or skipped setup. NULL means the
--                            app sends them to /setup once, from any device.
--   onboardingGoal         — LEADS | BILLING | DOCUMENTS | CONTENT: a product
--                            preference that orders Home's first action. It is
--                            NOT a fact about the business and never enters the
--                            knowledge snapshot.
--   onboardingGoalSource   — OWNER_SELECTED when the owner chose it, DEFAULTED
--                            when they skipped and the app derived one. A
--                            default is never recorded as an owner choice.
--
-- BusinessProfile is already under FORCE row-level security (p7w1_tenant) and
-- app_runtime holds table-level SELECT/INSERT/UPDATE
-- (20260915120000_businessprofile_runtime_grants), so new columns need no grant
-- and no policy. Expand-only: nothing existing changes meaning.
--
-- BACKFILL: every business that exists when this lands predates onboarding and
-- must never be routed into it. Each gets onboardingCompletedAt — on its
-- existing profile row, or on a new row holding only that stamp. No goal is
-- written for them (NULL, not a guess).
--
-- Rollback: DROP the two constraints and the three columns. The backfilled
-- rows hold nothing else and are harmless if left.
-- ============================================================================

ALTER TABLE "BusinessProfile"
  ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "onboardingGoal" TEXT,
  ADD COLUMN "onboardingGoalSource" TEXT;

ALTER TABLE "BusinessProfile"
  ADD CONSTRAINT "BusinessProfile_onboardingGoal_check"
    CHECK ("onboardingGoal" IS NULL
           OR "onboardingGoal" IN ('LEADS', 'BILLING', 'DOCUMENTS', 'CONTENT')),
  ADD CONSTRAINT "BusinessProfile_onboardingGoalSource_check"
    CHECK (("onboardingGoal" IS NULL AND "onboardingGoalSource" IS NULL)
           OR ("onboardingGoal" IS NOT NULL
               AND "onboardingGoalSource" IN ('OWNER_SELECTED', 'DEFAULTED')));

-- Timestamps in UTC, as Prisma writes them into timestamp(3) columns.
INSERT INTO "BusinessProfile" ("businessId", "onboardingCompletedAt", "createdAt", "updatedAt")
SELECT b."id", (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "Business" b
WHERE NOT EXISTS (SELECT 1 FROM "BusinessProfile" p WHERE p."businessId" = b."id");

UPDATE "BusinessProfile"
SET "onboardingCompletedAt" = (now() AT TIME ZONE 'UTC')
WHERE "onboardingCompletedAt" IS NULL;
