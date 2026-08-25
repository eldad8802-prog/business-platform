-- D2 / P7 Wave 3 — tenant RLS for the Inventory / Suppliers / POS cluster.
--
-- Same contract as Waves 1-2: EXPAND-ONLY, idempotent, role-free. INERT under
-- owner/BYPASSRLS runtimes (production today); enforcing under the Preview
-- least-privilege runtime role.
--
-- SPECIAL (deliberately NOT here): POSApiKey — the POS auth-mapping bootstrap
-- table. The x-pos-key lookup runs BEFORE any tenant context exists (it IS the
-- tenant resolution), so like User/Business it stays app-guarded with tight
-- grants and no tenant RLS.
--
-- No admin policies: no platform-admin path reads any Wave-3 table (verified).
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- Direct tenancy (businessId column) — 12 tables
-- ============================================================

ALTER TABLE "InventoryCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryCategory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryCategory";
CREATE POLICY p7w3_tenant ON "InventoryCategory"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryItem";
CREATE POLICY p7w3_tenant ON "InventoryItem"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryMovement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryMovement";
CREATE POLICY p7w3_tenant ON "InventoryMovement"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryAlert" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryAlert";
CREATE POLICY p7w3_tenant ON "InventoryAlert"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryDraft" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryDraft";
CREATE POLICY p7w3_tenant ON "InventoryDraft"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryPendingMatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryPendingMatch" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryPendingMatch";
CREATE POLICY p7w3_tenant ON "InventoryPendingMatch"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryExternalSale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryExternalSale" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "InventoryExternalSale";
CREATE POLICY p7w3_tenant ON "InventoryExternalSale"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "POSProductMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "POSProductMapping" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "POSProductMapping";
CREATE POLICY p7w3_tenant ON "POSProductMapping"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "SupplierPurchaseDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPurchaseDraft" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "SupplierPurchaseDraft";
CREATE POLICY p7w3_tenant ON "SupplierPurchaseDraft"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "Supplier";
CREATE POLICY p7w3_tenant ON "Supplier"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "PurchaseOrder";
CREATE POLICY p7w3_tenant ON "PurchaseOrder"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ReceivingSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceivingSession" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "ReceivingSession";
CREATE POLICY p7w3_tenant ON "ReceivingSession"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy (parent-join, schema-verified single hop) — 3 tables
-- ============================================================

ALTER TABLE "SupplierPurchaseDraftLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPurchaseDraftLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "SupplierPurchaseDraftLine";
CREATE POLICY p7w3_tenant ON "SupplierPurchaseDraftLine"
  USING (EXISTS (SELECT 1 FROM "SupplierPurchaseDraft" p WHERE p."id" = "SupplierPurchaseDraftLine"."draftId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "SupplierPurchaseDraft" p WHERE p."id" = "SupplierPurchaseDraftLine"."draftId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "PurchaseOrderLine";
CREATE POLICY p7w3_tenant ON "PurchaseOrderLine"
  USING (EXISTS (SELECT 1 FROM "PurchaseOrder" p WHERE p."id" = "PurchaseOrderLine"."purchaseOrderId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "PurchaseOrder" p WHERE p."id" = "PurchaseOrderLine"."purchaseOrderId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "ReceivingLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceivingLine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w3_tenant ON "ReceivingLine";
CREATE POLICY p7w3_tenant ON "ReceivingLine"
  USING (EXISTS (SELECT 1 FROM "ReceivingSession" p WHERE p."id" = "ReceivingLine"."receivingSessionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "ReceivingSession" p WHERE p."id" = "ReceivingLine"."receivingSessionId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));
