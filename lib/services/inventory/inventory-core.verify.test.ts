/**
 * Inventory core — extraction equivalence verifier.
 *
 * `inventory-core.ts` holds the smallest pure surface the Import preview needs:
 * the unit-type vocabulary (moved out of the items ROUTE, where the Import
 * layer could not reach it) and the two guards that ran at the top of
 * `createItemWithInitialStock`, before the transaction opens.
 *
 * Nothing about stock, movements, categories, suppliers or transactions moved,
 * and this file proves nothing about the RULES changed either: the
 * pre-extraction implementations are reproduced verbatim and both are run over
 * the same input matrix. Any divergence in value, thrown type or message fails
 * the build.
 *
 * Run: npx tsx lib/services/inventory/inventory-core.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { InventoryUnitType } from "@prisma/client";
import {
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";
import {
  assertInventoryItemName,
  assertNonNegativeQuantity,
  parseInventoryUnitType,
} from "@/lib/services/inventory/inventory-core";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* ---- the PRE-EXTRACTION implementations, reproduced verbatim ------------ */

/** Was `parseInventoryUnitType` in app/api/inventory/items/route.ts. */
function legacyParseUnitType(value: unknown): InventoryUnitType {
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

/** Was the `if (!name?.trim())` guard in createItemWithInitialStock. */
function legacyNameGuard(name: unknown): void {
  if (!(name as string)?.trim()) {
    throw new InventoryValidationError("Item name is required");
  }
}

/** Was the `if (initialQuantity < 0)` guard in createItemWithInitialStock. */
function legacyQuantityGuard(quantity: number): void {
  if (quantity < 0) {
    throw new NegativeInventoryError();
  }
}

function outcome(fn: () => unknown) {
  try {
    return { ok: true as const, value: fn() };
  } catch (e) {
    return {
      ok: false as const,
      name: (e as Error).constructor.name,
      msg: (e as Error).message,
    };
  }
}

/* ------------------------------------------------------- unit type ------ */

const UNIT_INPUTS: unknown[] = [
  "UNIT",
  "unit",
  "  Kg  ",
  "KG",
  "ML",
  "GRAM",
  "LITER",
  "BOX",
  "box",
  "",
  "   ",
  "PIECE",
  "יחידה",
  null,
  undefined,
  7,
  {},
  [],
  true,
];

check("parseInventoryUnitType matches the route's original behaviour", () => {
  for (const input of UNIT_INPUTS) {
    assert.deepEqual(
      outcome(() => parseInventoryUnitType(input)),
      outcome(() => legacyParseUnitType(input)),
      `unitType(${JSON.stringify(input)})`
    );
  }
});

check("the accepted vocabulary is exactly the Prisma enum", () => {
  for (const value of Object.values(InventoryUnitType)) {
    assert.equal(parseInventoryUnitType(value), value);
    assert.equal(parseInventoryUnitType(value.toLowerCase()), value);
  }
});

/* ------------------------------------------------------------ name ------ */

const NAME_INPUTS: unknown[] = [
  "חלב 3%",
  "  חלב 3%  ",
  "x",
  "",
  "   ",
  "\t\n",
  null,
  undefined,
  0,
  {},
];

check("the name guard matches the service's original behaviour", () => {
  for (const input of NAME_INPUTS) {
    const legacy = outcome(() => legacyNameGuard(input));
    const extracted = outcome(() => assertInventoryItemName(input));
    // The extracted version RETURNS the trimmed name where the guard returned
    // nothing; only the throw/no-throw decision and the error must match.
    assert.equal(extracted.ok, legacy.ok, `name(${JSON.stringify(input)})`);
    if (!extracted.ok && !legacy.ok) {
      assert.equal(extracted.name, legacy.name);
      assert.equal(extracted.msg, legacy.msg);
    }
  }
});

check("a valid name comes back trimmed", () => {
  assert.equal(assertInventoryItemName("  חלב 3%  "), "חלב 3%");
});

/* -------------------------------------------------------- quantity ------ */

check("the quantity guard matches the service's original behaviour", () => {
  for (const q of [0, 1, 0.5, 1000, -0.0001, -1, -1000, Number.MIN_SAFE_INTEGER]) {
    const legacy = outcome(() => legacyQuantityGuard(q));
    const extracted = outcome(() => assertNonNegativeQuantity(q));
    assert.equal(extracted.ok, legacy.ok, `quantity(${q})`);
    if (!extracted.ok && !legacy.ok) {
      assert.equal(extracted.name, legacy.name, `quantity(${q})`);
    }
  }
});

check("zero stock is allowed — 'none left' is a fact, not an error", () => {
  assert.equal(assertNonNegativeQuantity(0), 0);
  assert.throws(() => assertNonNegativeQuantity(-1), NegativeInventoryError);
});

/* ------------------------------------------------------- boundaries ----- */

check("BOUNDARY: the core module carries no DB or transaction behaviour", () => {
  const src = fs.readFileSync(
    "lib/services/inventory/inventory-core.ts",
    "utf8"
  );
  for (const needle of [
    "@/lib/prisma",
    "@/lib/tenant/",
    "$transaction",
    "findMany",
    "create(",
    "categoryId",
    "supplierName",
    "InventoryMovement",
  ]) {
    assert.equal(src.includes(needle), false, `inventory-core references ${needle}`);
  }
  // The Prisma ENUM is a vocabulary, not database access — that import is fine.
  assert.equal(src.includes('from "@prisma/client"'), true);
});

check("STRUCTURAL: the route and the service now use the shared rules", () => {
  const route = fs.readFileSync("app/api/inventory/items/route.ts", "utf8");
  assert.equal(route.includes("inventory-core"), true);
  assert.equal(
    /function parseInventoryUnitType/.test(route),
    false,
    "the route kept a private copy of the parser"
  );

  const service = fs.readFileSync(
    "lib/services/inventory/inventory.service.ts",
    "utf8"
  );
  assert.equal(service.includes("assertInventoryItemName"), true);
  assert.equal(service.includes("assertNonNegativeQuantity"), true);
  // The stock path itself must be untouched by the extraction.
  assert.equal(service.includes("InventoryMovementReason.INITIAL_STOCK"), true);
  assert.equal(service.includes("prisma.$transaction"), true);
});

console.log(`\nINVENTORY-CORE EQUIVALENCE PASS — ${passed} checks green.`);
