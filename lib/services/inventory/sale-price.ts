/**
 * Observed sale price. Absence stays absent.
 * Catalog, cost, and current item price are never consulted.
 */

const MONEY = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;
const MAX_CENTS = 9_999_999_99;

export type ObservedUnitPrice =
  | { kind: "absent" }
  | { kind: "present"; amount: string }
  | { kind: "invalid" };

export function observeUnitPrice(value: unknown): ObservedUnitPrice {
  if (value === undefined || value === null) return { kind: "absent" };

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return { kind: "invalid" };
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6) return { kind: "invalid" };
    if (cents > MAX_CENTS) return { kind: "invalid" };
    return { kind: "present", amount: (cents / 100).toFixed(2) };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { kind: "absent" };
    if (!MONEY.test(trimmed)) return { kind: "invalid" };
    const [whole, frac = ""] = trimmed.split(".");
    const amount = `${whole}.${frac.padEnd(2, "0")}`;
    const cents = Math.round(Number(amount) * 100);
    if (cents > MAX_CENTS) return { kind: "invalid" };
    return { kind: "present", amount };
  }

  return { kind: "invalid" };
}

export type ObservedSaleItem = {
  sku: string | null;
  barcode: string | null;
  name: string | null;
  quantity: number;
  unitPrice: string | null;
};

/**
 * When a pending POS sale is later applied as one stock movement, a unit
 * price is attributable only when that movement corresponds to exactly one
 * observed line that carried a price. Otherwise the price stays unknown.
 */
export function unitPriceForResolvedPending(metadata: {
  quantity: number;
  allItems?: { quantity: number; unitPrice?: string | null }[];
}): string | null {
  const lines = metadata.allItems ?? [];
  if (lines.length !== 1) return null;
  const line = lines[0];
  if (line.unitPrice == null || line.unitPrice === "") return null;
  if (Number(line.quantity) !== Number(metadata.quantity)) return null;
  const observed = observeUnitPrice(line.unitPrice);
  return observed.kind === "present" ? observed.amount : null;
}
