-- Payments core lab: the D2/P7-W4E-A (20260830120000) row-level security of "BusinessPaymentConnection",
-- verbatim — a `prisma db push` builds the table without it, and Production has it (runtime RLS evidence).
-- The migration under test must be proven under Production's controls. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'p7w4ea_tenant'
                   AND polrelid = '"BusinessPaymentConnection"'::regclass) THEN
    ALTER TABLE "BusinessPaymentConnection" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "BusinessPaymentConnection" FORCE ROW LEVEL SECURITY;
    CREATE POLICY p7w4ea_tenant ON "BusinessPaymentConnection"
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
  END IF;
END
$$;
