/**
 * Inventory domain core — pure validation, no Prisma, no DB, no transaction.
 *
 * Deliberately the SMALLEST surface the Import preview needs, and nothing more.
 * Explicitly NOT here: stock mutation, movement creation, category resolution,
 * supplier resolution, transaction behaviour. Those stay in
 * `inventory.service.ts`, where they belong.
 *
 * # Provenance
 *
 * `parseInventoryUnitType` was MOVED from `app/api/inventory/items/route.ts`
 * verbatim — it was already a standalone pure function sitting in a route file,
 * which is why the Import layer could not reach it.
 *
 * The name and quantity rules were lifted from the guard block at the top of
 * `createItemWithInitialStock`, which runs entirely BEFORE the transaction
 * opens. Same error types, same messages, same order. Equivalence is asserted
 * in `inventory-core.verify.test.ts` against reproductions of the originals.
 *
 * The `businessId` guard is intentionally left behind: the tenant is never a
 * spreadsheet's business, it comes from the session.
 */

import { InventoryUnitType } from "@prisma/client";
import {
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

/**
 * Parse the unit vocabulary. Required — a quantity without a unit is not a
 * fact. Accepts any case and surrounding whitespace, rejects everything else.
 */
export function parseInventoryUnitType(value: unknown): InventoryUnitType {
  if (typeof value !== "string") {
    throw new InventoryValidationError("unitType is required");
  }

  const normalizedValue = value.trim().toUpperCase();

  if (
    !Object.values(InventoryUnitType).includes(
      normalizedValue as InventoryUnitType
    )
  ) {
    throw new InventoryValidationError("Invalid unitType");
  }

  return normalizedValue as InventoryUnitType;
}

/**
 * An item must have a name. Mirrors the service's guard EXACTLY, including one
 * rough edge that is deliberately preserved rather than quietly improved:
 *
 *   `!(name as string)?.trim()` throws a raw TypeError for a non-nullish
 *   non-string (e.g. the number 0), not an InventoryValidationError.
 *
 * The equivalence verifier caught the difference when the first version of this
 * function "fixed" it. An extraction must not smuggle in a behaviour change to
 * a live stock-mutating service — tightening this is a separate, deliberate
 * change. The Import layer never reaches that path: it always passes a string.
 */
export function assertInventoryItemName(name: unknown): string {
  if (!(name as string)?.trim()) {
    throw new InventoryValidationError("Item name is required");
  }
  return (name as string).trim();
}

/** Stock can be zero, never negative. Mirrors the service's guard exactly. */
export function assertNonNegativeQuantity(quantity: number): number {
  if (quantity < 0) {
    throw new NegativeInventoryError();
  }
  return quantity;
}
