-- M7-B/C labs: the P1 (20260928120000) row-level security and runtime privileges of "OfferingDemandSignal",
-- verbatim — a `prisma db push` builds the table without them, and the M7-B/C migration and the demand
-- signals it enables must be proven under Production's controls. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'p1_offering_demand_select') THEN
    ALTER TABLE "OfferingDemandSignal" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "OfferingDemandSignal" FORCE ROW LEVEL SECURITY;
    CREATE POLICY p1_offering_demand_select ON "OfferingDemandSignal" FOR SELECT
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
    CREATE POLICY p1_offering_demand_insert ON "OfferingDemandSignal" FOR INSERT
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
    CREATE POLICY p1_offering_demand_update ON "OfferingDemandSignal" FOR UPDATE
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "OfferingDemandSignal" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OfferingDemandSignal_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "OfferingDemandSignal" FROM app_runtime;
  END IF;
END
$$;
