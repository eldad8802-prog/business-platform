import {
  InventoryMovementReason,
  InventoryMovementType,
  InventoryUnitType,
} from "@prisma/client";

export type CreateInventoryItemInput = {
  businessId: number;
  name: string;
  unitType: InventoryUnitType;
  initialQuantity?: number;
  minimumQuantity?: number;
  reorderPoint?: number;
  costPerUnit?: number;
  sellPricePerUnit?: number;
  sku?: string;
  barcode?: string;
  imageUrl?: string;
  createdByUserId?: number;
  categoryId?: number | null;
};

export type CreateInventoryMovementInput = {
  businessId: number;
  itemId: number;
  movementType: InventoryMovementType;
  reason: InventoryMovementReason;
  quantityDelta: number;
  note?: string;
  createdByUserId?: number;
};

export type AddInventoryStockInput = Omit<
  CreateInventoryMovementInput,
  "movementType"
>;

export type RemoveInventoryStockInput = Omit<
  CreateInventoryMovementInput,
  "movementType"
>;