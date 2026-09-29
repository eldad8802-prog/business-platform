-- Tenant/RLS closure — database-enforced isolation for five tenant-owned tables that had none.
--
-- WHY
-- InventorySale, InventorySaleLine (20260926120000), InventorySourceSaleLine, BusinessAsset
-- (20260927120000) and CouponSurfaceEvent (20260926120000) are tenant-owned and were shipped with no
-- RLS. Four were exempted by the RLS guard ("applied in Production before this guard"); the fifth keys
-- on issuingBusinessId, which the guard did not recognise as a tenant key at all. Their only protection
-- was application-level businessId filtering — NO ACTIVE EXPOSURE was found, but no isolation was
-- DATABASE-ENFORCED either, and with ALTER DEFAULT PRIVILEGES the runtime could read and write every
-- business's rows the moment any query forgot its filter.
--
-- WHAT
--   ENABLE + FORCE RLS; per-command policies (R2 — no FOR ALL, no DELETE policy) on the tenant key;
--   explicit grants matching exactly the operations the application performs (SELECT/INSERT, plus
--   UPDATE on InventorySourceSaleLine for sale-line linking); DELETE/TRUNCATE revoked.
--
-- Parent/child tenant integrity is already DATABASE-enforced by the composite (id, businessId) foreign
-- keys these tables were created with (sale lines → sale/item/movement; source lines → item/sale line;
-- assets → content run; surface events → coupon/offer), so no backfill or rewrite is needed and none
-- is performed. Foreign-key checks and cascades run outside RLS, so account deletion and the P1 link
-- tables are unaffected.
--
-- EXPAND-ONLY in effect: no table, column or row changes; only isolation and privileges tighten.
-- Fail-closed: with no tenant GUC, NULLIF yields NULL and no row qualifies.

-- ── InventorySale (businessId; SELECT, INSERT) ─────────────────────────────────

ALTER TABLE "InventorySale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySale" FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_sale_tenant_select ON "InventorySale" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY inventory_sale_tenant_insert ON "InventorySale" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── InventorySaleLine (businessId; SELECT, INSERT) ─────────────────────────────

ALTER TABLE "InventorySaleLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySaleLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_sale_line_tenant_select ON "InventorySaleLine" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY inventory_sale_line_tenant_insert ON "InventorySaleLine" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── InventorySourceSaleLine (businessId; SELECT, INSERT, UPDATE) ───────────────

ALTER TABLE "InventorySourceSaleLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventorySourceSaleLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_source_sale_line_tenant_select ON "InventorySourceSaleLine" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY inventory_source_sale_line_tenant_insert ON "InventorySourceSaleLine" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY inventory_source_sale_line_tenant_update ON "InventorySourceSaleLine" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── BusinessAsset (businessId; SELECT, INSERT) ─────────────────────────────────

ALTER TABLE "BusinessAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_asset_tenant_select ON "BusinessAsset" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY business_asset_tenant_insert ON "BusinessAsset" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── CouponSurfaceEvent (issuingBusinessId; SELECT, INSERT) ─────────────────────

ALTER TABLE "CouponSurfaceEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CouponSurfaceEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY coupon_surface_event_tenant_select ON "CouponSurfaceEvent" FOR SELECT
  USING ("issuingBusinessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY coupon_surface_event_tenant_insert ON "CouponSurfaceEvent" FOR INSERT
  WITH CHECK ("issuingBusinessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Named explicitly (R2). Production's default privileges would otherwise leave app_runtime holding
-- UPDATE/DELETE nobody asked for (BusinessAsset and CouponSurfaceEvent had no grant at all; the three
-- inventory tables were granted by hand in scripts/security/d2-p7-wave3-grants.sql). Guarded on the role
-- existing, so this is a no-op on a database without app_runtime.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "InventorySale" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySale_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "InventorySale" FROM app_runtime;
    GRANT SELECT, INSERT ON "InventorySaleLine" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySaleLine_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "InventorySaleLine" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "InventorySourceSaleLine" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventorySourceSaleLine_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "InventorySourceSaleLine" FROM app_runtime;
    GRANT SELECT, INSERT ON "BusinessAsset" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessAsset_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "BusinessAsset" FROM app_runtime;
    GRANT SELECT, INSERT ON "CouponSurfaceEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CouponSurfaceEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "CouponSurfaceEvent" FROM app_runtime;
  END IF;
END
$do$;
