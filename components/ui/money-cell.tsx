import { formatMoney } from "@/lib/ui/money";

/**
 * MoneyCell — PRESENTATION only. Renders a formatted amount with tabular numerals
 * and bidi isolation so the symbol+digits render as a stable unit inside RTL.
 * Column alignment (e.g. end) is the table cell's responsibility, not this cell's.
 * Never calculates, derives, or fetches; delegates formatting to `formatMoney`.
 */
export function MoneyCell({
  amount,
  currency,
}: {
  amount: number | string | null | undefined;
  currency?: string;
}) {
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", unicodeBidi: "isolate" }}>
      {formatMoney(amount, currency)}
    </span>
  );
}
