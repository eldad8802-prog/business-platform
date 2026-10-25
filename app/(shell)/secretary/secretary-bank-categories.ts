/**
 * "נגדיר את ההתחייבויות" — which ready-made category is already tracked.
 *
 * A category counts as saved when an open obligation's name contains its
 * Hebrew keyword. "ביטוחים" uses the keyword "ביטוח", which "ביטוח לאומי" also
 * contains; that item belongs to its own category, so it is excluded here.
 * Pure: it only reads names and never changes data.
 */

type Named = { obligeeName: string; ledger?: { title?: string } | null };

export type BankCategory = { keyword: string; exclude?: readonly string[] };

export const INSURANCE: BankCategory = { keyword: "ביטוח", exclude: ["ביטוח לאומי"] };
export const NATIONAL_INSURANCE: BankCategory = { keyword: "ביטוח לאומי" };

export function findCategoryObligation<T extends Named>(category: BankCategory | string, obligations: readonly T[]): T | null {
  const { keyword, exclude = [] } = typeof category === "string" ? { keyword: category } : category;
  const named = (name: string | undefined) => Boolean(name) && name!.includes(keyword) && !exclude.some((other) => name!.includes(other));
  return obligations.find((item) => named(item.ledger?.title) || named(item.obligeeName)) ?? null;
}
