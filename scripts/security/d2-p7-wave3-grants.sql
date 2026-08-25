-- D2 / P7 Wave 3 — least-privilege runtime grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the environment's tenant runtime role (Preview: app_runtime_preview_p4b).
-- Every verb is code-observed from the Wave-3 route/service inventory. No
-- admin grants: no platform-admin path reads any Wave-3 table (verified).
--
-- SPECIAL — POSApiKey (no tenant RLS; the POS auth bootstrap): SELECT for the
-- keyHash lookup + UPDATE for the fire-and-forget lastUsedAt touch. Rows are
-- created by ops/support, never by the runtime — no INSERT.

-- Inventory core
GRANT SELECT, INSERT ON "InventoryCategory" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryCategory_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "InventoryItem" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryItem_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "InventoryMovement" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryMovement_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "InventoryAlert" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryAlert_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "InventoryDraft" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryDraft_id_seq" TO :ROLE;

-- POS matching
GRANT SELECT, INSERT, UPDATE ON "InventoryPendingMatch" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryPendingMatch_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "InventoryExternalSale" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "InventoryExternalSale_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "POSProductMapping" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "POSProductMapping_id_seq" TO :ROLE;
GRANT SELECT, UPDATE ON "POSApiKey" TO :ROLE;

-- Supplier purchases
GRANT SELECT, INSERT, UPDATE ON "SupplierPurchaseDraft" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "SupplierPurchaseDraft_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "SupplierPurchaseDraftLine" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "SupplierPurchaseDraftLine_id_seq" TO :ROLE;

-- Suppliers + ordering
GRANT SELECT, INSERT, UPDATE ON "Supplier" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "Supplier_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "PurchaseOrder" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PurchaseOrder_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "PurchaseOrderLine" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "PurchaseOrderLine_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "ReceivingSession" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ReceivingSession_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "ReceivingLine" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ReceivingLine_id_seq" TO :ROLE;
