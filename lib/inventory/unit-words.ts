/**
 * Hebrew unit words for a quantity — "1 מארז", "5 מארזים", "12 יחידות", "2.5 ק״ג".
 * Presentation only; the stored unit enum and every quantity rule are unchanged.
 * Replaces raw enum codes ("UNIT", "KG") and singular-with-plural ("3 יחידה") in the UI.
 */
const WORDS: Record<string, { one: string; many: string }> = {
  UNIT: { one: "יחידה", many: "יחידות" },
  BOX: { one: "מארז", many: "מארזים" },
  KG: { one: "ק״ג", many: "ק״ג" },
  GRAM: { one: "גרם", many: "גרם" },
  LITER: { one: "ליטר", many: "ליטר" },
  ML: { one: "מ״ל", many: "מ״ל" },
};

export const UNIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "UNIT", label: "יחידה" },
  { value: "BOX", label: "מארז" },
  { value: "KG", label: "ק״ג" },
  { value: "GRAM", label: "גרם" },
  { value: "LITER", label: "ליטר" },
  { value: "ML", label: "מ״ל" },
];

export function unitWord(unitType: string | null | undefined, qty?: number | null): string {
  const w = WORDS[unitType ?? "UNIT"] ?? WORDS.UNIT;
  return qty === 1 ? w.one : w.many;
}

export function formatQtyNumber(qty: number): string {
  return qty.toLocaleString("he-IL", { maximumFractionDigits: 3 });
}

/** "5 מארזים" — number then unit word, grammatical for 1. */
export function qtyWithUnit(qty: number | null | undefined, unitType: string | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return "—";
  return `${formatQtyNumber(qty)} ${unitWord(unitType, qty)}`;
}
