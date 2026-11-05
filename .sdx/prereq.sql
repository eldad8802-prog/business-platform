-- Service external work lab: what Production has and a `prisma db push` cannot create. Idempotent.
--   D2 wave 3 20260825200000   "Supplier": ENABLE + FORCE RLS and its p7w3_tenant policy, verbatim (no later migration
--                              changed it). The supplier composite FK and the preflight's check 10 read exactly this.
ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "Supplier";
CREATE POLICY p7w3_tenant ON "Supplier"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
