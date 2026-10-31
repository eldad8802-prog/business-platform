-- Lead claimedPhone lab: what Production has on "Lead" and a `prisma db push` cannot create. Idempotent.
--   D2 P7 wave 1 20260824210000   "Lead": ENABLE + FORCE RLS and the p7w1_tenant policy, verbatim.
--   Leads W1 core 20260831090000  "Lead_open_phone_key": one OPEN lead per phone per business, verbatim.
-- The migration under test must leave all three untouched (preflight 5 + 7, proof, battery).
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "Lead";
CREATE POLICY p7w1_tenant ON "Lead"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE UNIQUE INDEX IF NOT EXISTS "Lead_open_phone_key"
  ON "Lead" ("businessId", "phone")
  WHERE "phone" IS NOT NULL AND "status" NOT IN ('WON', 'LOST', 'DROPPED');
