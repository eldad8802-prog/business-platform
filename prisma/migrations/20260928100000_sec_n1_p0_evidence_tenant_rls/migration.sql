-- SEC N-1 · Tenant isolation for the five P0 evidence tables.
--
-- 20260926120000_p0_business_evidence and 20260927120000_p0_asset_provenance_and_source_lines
-- created InventorySale, InventorySaleLine, InventorySourceSaleLine, BusinessAsset and
-- CouponSurfaceEvent with no row-level security, no policy and no explicit grant. Production
-- carries ALTER DEFAULT PRIVILEGES handing app_runtime a,r,w,d on every new table
-- (20260908200000_auth_session_privilege_contract), so the runtime identity could read and
-- write every tenant's rows in them with no database backstop.
--
-- This migration gives them the same isolation as every other tenant table: ENABLE + FORCE
-- RLS, per-command tenant policies keyed on the transaction-local GUC, and privileges named
-- explicitly. Nothing is altered, renamed, dropped or rewritten; there is no backfill.
--
-- EXISTING ROWS. Policies do not re-validate stored rows; WITH CHECK applies only to rows a
-- statement writes. Every existing row already carries a NOT NULL tenant column that a
-- (composite) foreign key ties to its parent's tenant, so each row simply becomes visible to
-- its own tenant only. Business deletion still cascades (FK actions run as the table owner).
--
-- DEPLOY ORDER. The application code must run every read and write on these tables inside a
-- tenant transaction BEFORE this migration is applied (see sec/n1-p0-evidence-tenant-scope).
-- Applied first, BusinessAsset reads would return nothing and its inserts, like the public
-- coupon-detail CouponSurfaceEvent insert, would be refused.
--
-- No app_admin policy: no admin path reads these tables.

-- ============================================================
-- InventorySale — tenant column "businessId". Code: SELECT, INSERT.
-- ============================================================
ALTER TABLE "InventorySale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySale" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_sale_tenant_read ON "InventorySale";
CREATE POLICY inventory_sale_tenant_read ON "InventorySale" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS inventory_sale_tenant_insert ON "InventorySale";
CREATE POLICY inventory_sale_tenant_insert ON "InventorySale" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- InventorySaleLine — tenant column "businessId" (stored; the composite FK
-- (saleId, businessId) -> InventorySale(id, businessId) pins it to the parent's tenant,
-- so no parent EXISTS join is needed). Code: SELECT, INSERT.
-- ============================================================
ALTER TABLE "InventorySaleLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySaleLine" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_sale_line_tenant_read ON "InventorySaleLine";
CREATE POLICY inventory_sale_line_tenant_read ON "InventorySaleLine" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS inventory_sale_line_tenant_insert ON "InventorySaleLine";
CREATE POLICY inventory_sale_line_tenant_insert ON "InventorySaleLine" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- InventorySourceSaleLine — tenant column "businessId". Code: SELECT, INSERT, UPDATE
-- (linkSourceLinesToSale sets saleLineId).
-- ============================================================
ALTER TABLE "InventorySourceSaleLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySourceSaleLine" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_source_sale_line_tenant_read ON "InventorySourceSaleLine";
CREATE POLICY inventory_source_sale_line_tenant_read ON "InventorySourceSaleLine" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS inventory_source_sale_line_tenant_insert ON "InventorySourceSaleLine";
CREATE POLICY inventory_source_sale_line_tenant_insert ON "InventorySourceSaleLine" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS inventory_source_sale_line_tenant_update ON "InventorySourceSaleLine";
CREATE POLICY inventory_source_sale_line_tenant_update ON "InventorySourceSaleLine" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- BusinessAsset — tenant column "businessId". Code: SELECT, INSERT.
-- ============================================================
ALTER TABLE "BusinessAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessAsset" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_asset_tenant_read ON "BusinessAsset";
CREATE POLICY business_asset_tenant_read ON "BusinessAsset" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS business_asset_tenant_insert ON "BusinessAsset";
CREATE POLICY business_asset_tenant_insert ON "BusinessAsset" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- CouponSurfaceEvent — tenant column "issuingBusinessId" (the coupon's issuing business,
-- pinned by the composite FKs to Coupon and Offer). Code: INSERT ... RETURNING, which
-- needs the row to pass the SELECT policy as well.
-- ============================================================
ALTER TABLE "CouponSurfaceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CouponSurfaceEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coupon_surface_event_tenant_read ON "CouponSurfaceEvent";
CREATE POLICY coupon_surface_event_tenant_read ON "CouponSurfaceEvent" FOR SELECT
  USING ("issuingBusinessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS coupon_surface_event_tenant_insert ON "CouponSurfaceEvent";
CREATE POLICY coupon_surface_event_tenant_insert ON "CouponSurfaceEvent" FOR INSERT
  WITH CHECK ("issuingBusinessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- PRIVILEGES — named explicitly, least privilege. ALTER DEFAULT PRIVILEGES handed
-- app_runtime a,r,w,d on each of these tables when they were created; the REVOKE takes back
-- every command the code does not use, so the grants agree with the policy set above.
-- Evidence rows are append-only for the application: no DELETE anywhere, UPDATE only where
-- a writer links a source line to its sale line. Guarded on the role existing, so this is a
-- clean no-op on a database without app_runtime.
-- ============================================================
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "InventorySale" FROM app_runtime;
    GRANT SELECT, INSERT ON "InventorySale" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySale_id_seq" TO app_runtime;

    REVOKE ALL ON "InventorySaleLine" FROM app_runtime;
    GRANT SELECT, INSERT ON "InventorySaleLine" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySaleLine_id_seq" TO app_runtime;

    REVOKE ALL ON "InventorySourceSaleLine" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "InventorySourceSaleLine" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySourceSaleLine_id_seq" TO app_runtime;

    REVOKE ALL ON "BusinessAsset" FROM app_runtime;
    GRANT SELECT, INSERT ON "BusinessAsset" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessAsset_id_seq" TO app_runtime;

    REVOKE ALL ON "CouponSurfaceEvent" FROM app_runtime;
    GRANT SELECT, INSERT ON "CouponSurfaceEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CouponSurfaceEvent_id_seq" TO app_runtime;
  END IF;
END
$do$;
