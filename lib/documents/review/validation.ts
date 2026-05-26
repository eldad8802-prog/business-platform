import type { Direction } from "./types";
import { formatDateShort } from "./format";

export function parseDirection(v: unknown): Direction {
  if (v === "income" || v === "expense") return v;
  return "unknown";
}

export function isValidPositiveAmount(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function hasNonEmptyText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function firstMissingFinancialField(draft: {
  amount: number | null;
  vendorName: string;
  date: string | null;
  direction: Direction;
  category: string;
}): "amount" | "vendorName" | "date" | "direction" | "category" | null {
  if (!isValidPositiveAmount(draft.amount)) return "amount";
  if (!hasNonEmptyText(draft.vendorName)) return "vendorName";
  if (!draft.date || !formatDateShort(draft.date)) return "date";
  if (draft.direction !== "expense" && draft.direction !== "income") return "direction";
  if (!hasNonEmptyText(draft.category)) return "category";
  return null;
}
