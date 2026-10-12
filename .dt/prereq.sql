-- Daily Tasks labs: the DB-only objects the foundation migration builds on, exactly as Production has them
-- (a `prisma db push` cannot create them). Idempotent.
--   sec-C 20260926110000   Customer / Lead (businessId, id) keys — targets of the composite tenant FKs
--   D2/P7 wave 1 20260824210000   "Task": ENABLE + FORCE RLS and the FOR ALL policy p7w1_tenant, verbatim
--                          (gate run 38287077419 measured exactly this policy in Production)
-- The runtime's privileges on "Task" are NOT added here: the lab owner's DEFAULT PRIVILEGES already handed
-- them out when `db push` created the table — the same way Production got them (G4).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_businessId_id_key') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
END
$$;

ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w1_tenant ON "Task";
CREATE POLICY p7w1_tenant ON "Task"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
