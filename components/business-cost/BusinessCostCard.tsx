"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  fetchBusinessCostSummary,
  fetchLearnedCostInsights,
  type BusinessCostSummaryApi,
  type LearnedCostInsightApi,
} from "@/lib/business-cost/business-cost-client";

const DS = TOKEN.dsv1;

/** The Secretary's own style: "3,050 ₪", agorot only when there are any. */
const ils = (decimal: string) => {
  const n = Number(decimal);
  const frac = Number.isInteger(n) ? 0 : 2;
  return `${n.toLocaleString("he-IL", { minimumFractionDigits: frac, maximumFractionDigits: frac })} ₪`;
};

/** Learned insights shown at once; the rest open on demand. The card is a summary, not a feed. */
const VISIBLE_INSIGHTS = 2;

/** Data gaps the owner can act on. Others (an unconfirmed backbone, foreign currency) stay in the gate, silently. */
const ACTIONABLE_GAP = /#(UNALLOCATED_CASH|DUE_WITHOUT_RECORDED_PAYMENT|ONE_OFF_COVERAGE_UNKNOWN)$/;

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
 *
 * "מה השתנה" shows the LEARNED cost insights (Business Cost learning: governed
 * policies, gated by COST-08, evidence-linked), from GET /api/insights — FACT
 * or PATTERN, each labelled as such, its facts on demand. COST-08 is a gate,
 * not news: a reliability note appears only for gaps the owner can close
 * (unlinked payments, due dates without a recorded payment, one-offs without a
 * period); an unconfirmed backbone or foreign currency stays silent in the gate.
 * Nothing here interprets, recommends or decides.
 */
export function BusinessCostCard() {
  const [summary, setSummary] = useState<BusinessCostSummaryApi | null>(null);
  const [learned, setLearned] = useState<LearnedCostInsightApi[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchBusinessCostSummary(controller.signal)
      .then(setSummary)
      .catch(() => {
        /* silent: never block the Secretary */
      });
    fetchLearnedCostInsights(controller.signal)
      .then(setLearned)
      .catch(() => {
        /* silent: insights are an addition, never a dependency */
      });
    return () => controller.abort();
  }, []);

  if (!summary || summary.baseline.completeness.state === "EMPTY") return null;
  // Only the actionable engine reason is worth a sentence: one-off costs whose period is unknown are left out.
  const oneOffsUnplaced = summary.baseline.completeness.reasons.includes("UNALLOCATABLE_COMMITMENTS");
  const overdue = Number(summary.upcoming.overdue.total) > 0;
  const changes = learned
    .filter((i) => i.insightKey !== "cost.data_completeness")
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : b.id - a.id));
  const visible = showAll ? changes : changes.slice(0, VISIBLE_INSIGHTS);
  const gapLines = (learned.find((i) => i.insightKey === "cost.data_completeness")?.factLines ?? []).filter((f) => ACTIONABLE_GAP.test(f.sourceRef));

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
        // Rendered inside the Secretary home shell, in its column.
        marginTop: 16,
        width: "100%",
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
      {changes.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15, color: DS.ink }}>מה השתנה</h3>
          {visible.map((i) => (
            <LearnedInsight key={i.id} insight={i} />
          ))}
          {changes.length > VISIBLE_INSIGHTS ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} style={linkButton}>
              {showAll ? "הצג פחות" : changes.length - VISIBLE_INSIGHTS === 1 ? "עוד שינוי אחד" : `עוד ${changes.length - VISIBLE_INSIGHTS} שינויים`}
            </button>
          ) : null}
        </div>
      ) : null}
      {gapLines.length > 0 ? <ReliabilityNote lines={gapLines.map((f) => f.text)} /> : oneOffsUnplaced ? (
        <p style={{ margin: "8px 0 0", color: DS.tertiary, fontSize: 13 }}>
          יש הוצאות חד־פעמיות שלא נרשם לאיזו תקופה הן שייכות, ולכן הן לא נכללות בעלות היומית.
        </p>
      ) : null}
    </section>
  );
}

const LEVEL_LABEL: Record<string, string> = {
  FACT: "עובדה שנרשמה",
  PATTERN: "השוואה להיסטוריה של העסק",
};

function LearnedInsight({ insight }: { insight: LearnedCostInsightApi }) {
  const [open, setOpen] = useState(false);
  const level = insight.contributingRules[0]?.level;
  return (
    <div style={{ marginTop: 8, background: DS.surface2, borderRadius: 12, padding: "10px 12px" }}>
      {level && LEVEL_LABEL[level] ? <div style={{ color: DS.muted, fontSize: 12 }}>{LEVEL_LABEL[level]}</div> : null}
      <div style={{ fontWeight: 600, color: DS.ink }}>{insight.title}</div>
      <div style={{ color: DS.ink, fontSize: 14, lineHeight: 1.6 }}>{insight.factLines[0]?.text}</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ marginTop: 4, padding: 0, border: 0, background: "none", color: DS.accent, fontSize: 13, cursor: "pointer", font: "inherit" }}
      >
        {open ? "הסתר" : "למה?"}
      </button>
      {open ? (
        <ul style={{ margin: "6px 0 0", paddingInlineStart: 18, color: DS.ink, fontSize: 13, lineHeight: 1.7 }}>
          {insight.factLines.slice(1).map((f, k) => (
            <li key={k}>{f.text}</li>
          ))}
          <li style={{ color: DS.muted }}>
            {insight.uncertainty ?? "מבוסס על הרישומים של העסק בלבד."}
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function ReliabilityNote({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "10px 0 0", color: DS.tertiary, fontSize: 13 }}>
      <span>חלק מנתוני העלות עוד לא נרשמו במלואם, ולכן ההשוואות מבוססות רק על מה שנרשם. </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ padding: 0, border: 0, background: "none", color: DS.accent, fontSize: 13, cursor: "pointer", font: "inherit" }}
      >
        {open ? "הסתר" : "מה חסר?"}
      </button>
      {open ? (
        <ul style={{ margin: "6px 0 0", paddingInlineStart: 18, lineHeight: 1.7 }}>
          {lines.map((t, k) => (
            <li key={k}>{t}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const linkButton = { marginTop: 6, padding: 0, border: 0, background: "none", color: DS.accent, fontSize: 13, cursor: "pointer", font: "inherit" } as const;
