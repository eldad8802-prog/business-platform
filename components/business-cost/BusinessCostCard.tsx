"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { fetchBusinessCostSummary, type BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";

const DS = TOKEN.dsv1;

const ils = (decimal: string) =>
  `₪${Number(decimal).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * The Secretary's cost line: what the business costs, what actually left, what
 * is coming — straight from GET /api/business-cost/summary (one deterministic
 * engine). Read-only. Silent when there is nothing recorded yet or when the
 * section cannot load: the payment Secretary must keep working either way.
 *
 * Three different numbers, never blended:
 *   עלות יום פעילות ממוצע  the normalised recurring baseline (operating only)
 *   יצא היום בפועל          payments recorded with today's date (cash out)
 *   צפוי לצאת השבוע         still-to-pay obligations in the next 7 days
 * No profit, margin or break-even is shown — they are not known.
 */
export function BusinessCostCard() {
  const [summary, setSummary] = useState<BusinessCostSummaryApi | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchBusinessCostSummary(controller.signal)
      .then(setSummary)
      .catch(() => {
        /* silent: never block the Secretary */
      });
    return () => controller.abort();
  }, []);

  if (!summary || summary.baseline.completeness.state === "EMPTY") return null;
  const partial = summary.baseline.completeness.state === "PARTIAL";
  const overdue = Number(summary.upcoming.overdue.total) > 0;

  const row = (label: string, value: string, hint?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: `1px solid ${DS.line}` }}>
      <div>
        <div style={{ color: DS.ink }}>{label}</div>
        {hint ? <div style={{ color: DS.muted, fontSize: 13 }}>{hint}</div> : null}
      </div>
      <bdi style={{ fontWeight: 600, color: DS.ink, whiteSpace: "nowrap" }}>{value}</bdi>
    </div>
  );

  return (
    <section
      dir="rtl"
      aria-label="כמה העסק עולה"
      style={{
        margin: "16px auto",
        width: "min(100% - 32px, 720px)",
        boxSizing: "border-box",
        background: DS.card,
        border: `1px solid ${DS.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 17, color: DS.ink }}>כמה העסק עולה</h2>
      {row("עלות יום פעילות ממוצע", ils(summary.baseline.daily), `${ils(summary.baseline.monthly)} לחודש בהוצאות קבועות`)}
      {row("יצא היום בפועל", ils(summary.periods.today.cashOut), `החודש: ${ils(summary.periods.thisMonth.cashOut)}`)}
      {row("צפוי לצאת ב־7 הימים הקרובים", ils(summary.upcoming.next7Days.total), `ב־30 יום: ${ils(summary.upcoming.next30Days.total)}`)}
      {overdue ? row("באיחור", ils(summary.upcoming.overdue.total)) : null}
      {summary.insights.map((i) => (
        <div key={i.dedupeKey} style={{ marginTop: 10, background: DS.surface2, borderRadius: 12, padding: "10px 12px" }}>
          <div style={{ fontWeight: 600, color: DS.ink }}>{i.title}</div>
          <div style={{ color: DS.ink, fontSize: 14, lineHeight: 1.6 }}>{i.body}</div>
          <div style={{ color: DS.muted, fontSize: 13 }}>{i.why}</div>
        </div>
      ))}
      {partial ? (
        <p style={{ margin: "8px 0 0", color: DS.tertiary, fontSize: 13 }}>
          חלק מההוצאות עוד לא ידועות במלואן — המספרים מבוססים רק על מה שנרשם.
        </p>
      ) : null}
    </section>
  );
}
