import { observeUnitPrice } from "@/lib/services/inventory/sale-price";

/**
 * The charged total a manual sale shows before it is recorded.
 *
 * "מחיר שנגבה" is a price PER UNIT: the API field is `unitPrice`, it is stored on
 * InventorySaleLine next to `quantity`, and the line shows the catalogue price per
 * unit beside it. So a line contributes quantity × unit price. The screen used to
 * add the unit prices alone (audit 2026-11-03, ב7).
 *
 * Arithmetic is in agorot, so 3 × 19.90 is 59.70 exactly. A blank price stays
 * absent — it adds nothing and is not counted as 0; a typed "0" is a real zero
 * price. Any invalid price makes the whole total invalid (the screen already
 * blocks submit in that case).
 */
export type ChargedTotal =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "total"; cents: number; pricedLines: number; unpricedLines: number };

export function chargedSaleTotal(
  lines: ReadonlyArray<{ quantity: number; rawPrice: string | null | undefined }>
): ChargedTotal {
  let cents = 0;
  let pricedLines = 0;
  let unpricedLines = 0;
  for (const line of lines) {
    const raw = (line.rawPrice ?? "").trim();
    if (!raw) {
      unpricedLines += 1;
      continue;
    }
    const observed = observeUnitPrice(raw);
    if (observed.kind === "invalid") return { kind: "invalid" };
    if (observed.kind === "absent") {
      unpricedLines += 1;
      continue;
    }
    const [whole, frac = "00"] = observed.amount.split(".");
    const unitCents = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
    cents += Math.round(unitCents * line.quantity);
    pricedLines += 1;
  }
  if (pricedLines === 0) return { kind: "none" };
  return { kind: "total", cents, pricedLines, unpricedLines };
}
