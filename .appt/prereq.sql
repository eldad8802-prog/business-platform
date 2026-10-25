-- Appointments labs: what Production has on "Appointment" and a `prisma db push` cannot create. Idempotent.
--   D2 cutover-2B 20260902120000   "Appointment": ENABLE + FORCE RLS and the three per-command p7pilot_* policies,
--                                  verbatim (no DELETE policy). The migration under test must leave them untouched.
-- The runtime's privileges on "Appointment" are NOT added here: the lab owner's DEFAULT PRIVILEGES already handed
-- them out when `db push` created the table — the historical broad grant the cutover-2B header records.
ALTER TABLE "Appointment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Appointment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p7pilot_tenant_read ON "Appointment";
CREATE POLICY p7pilot_tenant_read ON "Appointment" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_insert ON "Appointment";
CREATE POLICY p7pilot_tenant_insert ON "Appointment" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS p7pilot_tenant_update ON "Appointment";
CREATE POLICY p7pilot_tenant_update ON "Appointment" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
