/**
 * What the inventory supplier picker offers, and in what order.
 *
 * Kept apart from `supplier-field.tsx` deliberately: this is where the actual
 * decisions live — which suppliers appear, which snapshot names survive, and the
 * exact condition under which "create a new supplier" is offered — and a pure
 * module can be tested directly, without a DOM or a stylesheet in the way.
 */
import { inventoryTextKey, normalizeInventoryText } from "@/lib/inventory/normalize";

/**
 * One row in the picker.
 *  - `entity` — a canonical Supplier. Carries an id for provenance only; what
 *    reaches the inventory item is still the NAME (Tier-1 snapshot).
 *  - `orphan` — a `supplierName` already written on an inventory item with no
 *    Supplier record behind it. Kept so existing data stays selectable.
 *  - `create` — the escape hatch that opens quick-create.
 */
export type SupplierChoice =
  | { kind: "entity"; id: number; name: string }
  | { kind: "orphan"; name: string }
  | { kind: "create"; name: string };

export function buildSupplierChoices({
  entities,
  orphanNames,
  query,
}: {
  entities: Array<{ id: number; name: string }>;
  orphanNames: string[];
  query: string;
}): SupplierChoice[] {
  const typed = normalizeInventoryText(query);
  const typedKey = inventoryTextKey(typed);

  const seen = new Set<string>();
  const out: SupplierChoice[] = [];

  // Canonical entities first — they are the real thing, and the server has
  // already filtered them by the query.
  for (const e of entities) {
    const name = normalizeInventoryText(e.name);
    if (!name) continue;
    const key = inventoryTextKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "entity", id: e.id, name });
  }

  // Then snapshot names with no entity behind them. Filtered client-side because
  // they come from already-loaded items, not from a query the server ran.
  for (const raw of orphanNames) {
    const name = normalizeInventoryText(raw);
    if (!name) continue;
    const key = inventoryTextKey(name);
    if (seen.has(key)) continue;
    if (typedKey && !key.includes(typedKey)) continue;
    seen.add(key);
    out.push({ kind: "orphan", name });
  }

  // Offer creation only when the owner has typed something that is not already
  // an exact option. A NEAR match still offers it: deciding whether "Strauss"
  // and "Strauss Ltd" are the same business belongs to the duplicate advisory,
  // after creation — it is not a judgement this picker may make silently.
  if (typed && !seen.has(typedKey)) {
    out.push({ kind: "create", name: typed });
  }

  return out;
}
