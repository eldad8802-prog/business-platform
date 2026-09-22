-- M3 · BusinessInsight — what Dubiz noticed, and what the owner decided about it.
--
-- Additive only: one new table, one new enum, nothing altered, no data transformed.
--
-- The owner's decision is the point of this table. Everywhere else in this codebase a dismissal is UI
-- state that evaporates; here it is durable evidence with an actor and a timestamp, because outcome
-- learning later has nothing to stand on if we cannot say what was shown and what was decided.

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('OPEN', 'ADOPTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "BusinessInsight" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "insightKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "factLines" JSONB NOT NULL,
    "interpretation" TEXT,
    "uncertainty" TEXT,
    "contributingRules" JSONB NOT NULL,
    "suggestedActions" JSONB,
    "status" "InsightStatus" NOT NULL DEFAULT 'OPEN',
    "ownerDecisionAt" TIMESTAMP(3),
    "ownerDecisionByUserId" INTEGER,
    "ownerDecisionNote" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "composerVersion" TEXT NOT NULL,

    CONSTRAINT "BusinessInsight_pkey" PRIMARY KEY ("id")
);

-- One LIVE insight per (business, dedupeKey). An owner who dismissed something must not meet it again
-- tomorrow as a brand-new row; the composer refreshes the existing one instead.
CREATE UNIQUE INDEX "BusinessInsight_businessId_dedupeKey_key" ON "BusinessInsight"("businessId", "dedupeKey");
CREATE INDEX "BusinessInsight_businessId_status_idx" ON "BusinessInsight"("businessId", "status");

-- AddForeignKey
ALTER TABLE "BusinessInsight" ADD CONSTRAINT "BusinessInsight_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant row-level security, on the same terms as the knowledge it is composed from.
ALTER TABLE "BusinessInsight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessInsight" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "BusinessInsight";
CREATE POLICY p7w2_tenant ON "BusinessInsight"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Runtime grants, shipped with the definition rather than applied separately by hand.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "BusinessInsight" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessInsight_id_seq" TO app_runtime;
  END IF;
END
$do$;
