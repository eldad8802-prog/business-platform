/**
 * Presentation-only formatting helpers for the Documents home screen.
 * No data-layer coupling — pure string/number formatting shared by the
 * container page and the Pulse card.
 */

export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ש"ח`;
  }
}

export function monthLabel(raw: string): string {
  if (!raw) return "ללא חודש";
  const [year, month] = raw.split("-");
  if (!year || !month) return raw;
  const d = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

export function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
