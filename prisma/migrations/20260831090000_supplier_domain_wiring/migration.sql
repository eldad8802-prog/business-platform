-- Supplier domain wiring — EXPAND ONLY.
-- Every column added here is nullable with no default and no backfill: existing
-- rows are untouched and every existing read path keeps working unchanged.
--
-- 1) SupplierPurchaseDraft.supplierId — the Tier-2 Entity-FK that was missing.
--    PurchaseOrder.supplierId already existed; the draft (which is what the
--    order wizard actually creates) had no way to carry the chosen supplier, so
--    approval could only pass a name and every PO landed with supplierId NULL.
-- 2) Supplier business-profile columns — business identity, contact, address,
--    payment terms/method. Reuses the existing "CustomerTaxIdType" and
--    "PaymentMethod" enums rather than defining supplier-only duplicates.

ALTER TABLE "SupplierPurchaseDraft" ADD COLUMN "supplierId" INTEGER;

ALTER TABLE "SupplierPurchaseDraft"
  ADD CONSTRAINT "SupplierPurchaseDraft_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SupplierPurchaseDraft_businessId_supplierId_idx"
  ON "SupplierPurchaseDraft"("businessId", "supplierId");

ALTER TABLE "Supplier" ADD COLUMN "legalName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "taxId" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "taxIdType" "CustomerTaxIdType";
ALTER TABLE "Supplier" ADD COLUMN "category" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "website" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "contactName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "contactRole" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "addressStreet" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "addressPostalCode" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "paymentTermsDays" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN "preferredPaymentMethod" "PaymentMethod";

CREATE INDEX "Supplier_businessId_taxId_idx" ON "Supplier"("businessId", "taxId");
