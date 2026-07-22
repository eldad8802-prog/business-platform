"use client";

import { formatMoney } from "./home-format";

type PulseCardProps = {
  monthLabel: string;
  income: number;
  expense: number;
  net: number;
  /** Net cash-flow of the previous month; null when there is no prior data. */
  previousNet: number | null;
};

/**
 * Real month-over-month net delta, or null when it can't be computed honestly:
 * no prior data (`previousNet === null`) or a zero baseline (division by zero).
 * Never estimated. `pct` is a whole-number percentage; `dir` gives the arrow.
 */
export function computeDelta(
  net: number,
  previousNet: number | null
): { pct: number; dir: "up" | "down" | "flat" } | null {
  if (previousNet == null || previousNet === 0) return null;
  if (!Number.isFinite(net) || !Number.isFinite(previousNet)) return null;
  const pct = Math.round(((net - previousNet) / Math.abs(previousNet)) * 100);
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return { pct, dir };
}

/**
 * Net cash-flow card (top of the Documents home). A proportional income/expense
 * meter + legend. Presentation only — values come straight from the hub summary
 * `financialPulse.fromFinancialRecords`.
 *
 * The month-over-month delta tag renders only when a real comparison exists
 * (see {@link computeDelta}); it is never shown for a missing or zero baseline.
 */
export default function PulseCard({
  monthLabel,
  income,
  expense,
  net,
  previousNet,
}: PulseCardProps) {
  const total = Math.max(0, income) + Math.max(0, expense);
  const incomePct = total > 0 ? (Math.max(0, income) / total) * 100 : 0;
  const expensePct = total > 0 ? 100 - incomePct : 0;

  const delta = computeDelta(net, previousNet);
  const deltaArrow = delta ? (delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "") : "";

  const netStr = formatMoney(net);
  // Split currency glyph so it can render smaller, matching the mockup.
  const netMatch = /^([^\d-]*)(.*)$/.exec(netStr);
  const netPrefix = netMatch?.[1] ?? "";
  const netBody = netMatch?.[2] ?? netStr;

  return (
    <section className="dz-pulse" aria-label="תזרים נטו">
      <div className="dz-pulse__row">
        <div>
          <div className="dz-pulse__lbl">תזרים נטו · {monthLabel}</div>
          <div className="dz-pulse__net">
            {netPrefix ? <span className="dz-pulse__cur">{netPrefix}</span> : null}
            {netBody}
          </div>
        </div>
        {delta ? (
          <span className={`dz-pulse__delta dz-pulse__delta--${delta.dir}`}>
            {deltaArrow ? <span aria-hidden>{deltaArrow}</span> : null}
            {Math.abs(delta.pct)}%
          </span>
        ) : null}
      </div>

      <div className="dz-meter" role="presentation">
        <div className="dz-meter__inc" style={{ width: `${incomePct}%` }} />
        <div className="dz-meter__exp" style={{ width: `${expensePct}%` }} />
      </div>

      <div className="dz-legend">
        <div className="dz-legend__it">
          <span className="dz-legend__sw dz-legend__sw--inc" />
          <span className="dz-legend__k">הכנסות</span>
          <span className="dz-legend__v">{formatMoney(income)}</span>
        </div>
        <div className="dz-legend__it">
          <span className="dz-legend__sw dz-legend__sw--exp" />
          <span className="dz-legend__k">הוצאות</span>
          <span className="dz-legend__v">{formatMoney(expense)}</span>
        </div>
      </div>
    </section>
  );
}
