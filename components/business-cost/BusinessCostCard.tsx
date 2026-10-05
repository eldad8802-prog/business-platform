"use client";

import { useEffect, useState, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  affirmRecurringCostsRecorded,
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

/**
 * Data gaps the owner can act on. Others (an unconfirmed backbone, foreign currency) stay in the gate, silently;
 * one-offs without a period are already listed under the monthly cost as "not included".
 */
const ACTIONABLE_GAP = /#(UNALLOCATED_CASH|DUE_WITHOUT_RECORDED_PAYMENT)$/;

const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
/** "2026-10" → "אוקטובר". From the server's business-local month, never the browser clock. */
const monthName = (month: string) => HE_MONTHS[Number(month.slice(5, 7)) - 1] ?? "";
/** "2026-10-02" → "2/10/2026". */
const heDate = (civil: string) => {
  const [y, m, d] = civil.split("-").map(Number);
  return `${d}/${m}/${y}`;
};
/** How often the owner pays it, as recorded. */
const CADENCE_NAME: Record<string, string> = { DAILY: "יומי", WEEKLY: "שבועי", BIWEEKLY: "דו־שבועי", MONTHLY: "חודשי", BIMONTHLY: "דו־חודשי", QUARTERLY: "רבעוני", SEMIANNUAL: "חצי־שנתי", YEARLY: "שנתי" };
const PER_PERIOD: Record<string, string> = { DAILY: "ביום", WEEKLY: "בשבוע", BIWEEKLY: "כל שבועיים", BIMONTHLY: "כל חודשיים", QUARTERLY: "כל רבעון", SEMIANNUAL: "כל חצי שנה", YEARLY: "בשנה" };

/**
 * The Secretary's cost line: what the business costs, what actually left, what
 * is coming — straight from GET /api/business-cost/summary (one deterministic
 * engine). Read-only. Silent when there is nothing recorded yet or when the
 * section cannot load: the payment Secretary must keep working either way.
 *
 * First, the two answers the owner asked for, from the recorded recurring
 * operating commitments valid today:
 *   עלות חודשית קבועה   the normalised monthly cost (baseline.monthly)
 *   עלות ליום ב<חודש>    that monthly cost ÷ the actual days of THIS calendar
 *                       month (baseline.calendarDay) — every day, open or not,
 *                       because rent and insurance cost on closed days too.
 *                       Shown with its arithmetic, never as a black box.
 * "ממה זה מורכב" lists each commitment's monthly share, then what is NOT
 * included (loan repayments, one-offs without a period). Until the owner
 * affirms the list is complete (the Secretary's existing orientation), the
 * monthly cost says "לפי ההתחייבויות שרשמת"; after, it says when they affirmed.
 * Then, apart: cash that actually left today, and what is due in 7 days.
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
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [affirming, setAffirming] = useState<"idle" | "saving" | "failed">("idle");

  const loadSummary = (signal?: AbortSignal) =>
    fetchBusinessCostSummary(signal)
      .then(setSummary)
      .catch(() => {
        /* silent: never block the Secretary */
      });

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    fetchLearnedCostInsights(controller.signal)
      .then(setLearned)
      .catch(() => {
        /* silent: insights are an addition, never a dependency */
      });
    return () => controller.abort();
  }, []);

  if (!summary || summary.baseline.completeness.state === "EMPTY") return null;
  const b = summary.baseline;
  const { affirmed, affirmedOn } = b.affirmation;
  const oneOffs = b.uncertainItems.filter((u) => u.reason === "ONE_OFF_COVERAGE_UNKNOWN" || u.reason === "PAYMENT_PLAN_COVERAGE_UNKNOWN");
  const unreadable = b.uncertainItems.filter((u) => !oneOffs.includes(u));
  const notIncluded = [
    b.debtServiceLines.length > 0 ? `החזרי הלוואות (${ils(b.debtServiceMonthly)} לחודש)` : null,
    oneOffs.length === 1 ? "הוצאה חד־פעמית אחת" : oneOffs.length > 1 ? `${oneOffs.length} הוצאות חד־פעמיות` : null,
    unreadable.length === 1 ? "התחייבות אחת שלא ניתן לחשב" : unreadable.length > 1 ? `${unreadable.length} התחייבויות שלא ניתן לחשב` : null,
  ].filter((t): t is string => t !== null);
  const lines = [...b.lines].sort((x, y) => Number(y.monthly) - Number(x.monthly) || x.commitmentId - y.commitmentId);

  const affirm = () => {
    setAffirming("saving");
    affirmRecurringCostsRecorded()
      .then(() => loadSummary())
      .then(() => setAffirming("idle"))
      .catch(() => setAffirming("failed"));
  };
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Figure
          label="עלות חודשית קבועה"
          value={ils(b.monthly)}
          hint={affirmed ? (affirmedOn ? `כל ההוצאות הקבועות · אישרת ב־${heDate(affirmedOn)}` : "כל ההוצאות הקבועות · אישרת שרשמת את כולן") : "לפי ההתחייבויות שרשמת"}
        />
        <Figure
          label={`עלות ליום ב${monthName(b.calendarDay.month)}`}
          value={ils(b.calendarDay.daily)}
          hint={
            <>
              {/* The arithmetic reads left-to-right as one unit, never split or reordered by the RTL line. */}
              <bdi dir="ltr" style={{ whiteSpace: "nowrap" }}>{`${ils(b.monthly)} ÷ ${b.calendarDay.daysInMonth}`}</bdi> ימי החודש
            </>
          }
        />
      </div>
      {notIncluded.length > 0 ? (
        <div style={{ marginTop: 6, color: DS.muted, fontSize: 13 }}>
          לא כולל:{" "}
          {notIncluded.map((t, k) => (
            <span key={t} style={{ whiteSpace: "nowrap" }}>
              {k > 0 ? " · " : ""}
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <button type="button" onClick={() => setShowBreakdown((v) => !v)} aria-expanded={showBreakdown} style={linkButton}>
        {showBreakdown ? "הסתר פירוט" : "ממה זה מורכב"}
      </button>
      {showBreakdown ? (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 14 }}>
          {lines.map((l) => (
            <li key={l.commitmentId} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderTop: `1px solid ${DS.line}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: DS.ink }}>{l.title}</div>
                <div style={{ color: DS.muted, fontSize: 12 }}>
                  {CADENCE_NAME[l.recurrence] ?? "חוזר"}
                  {PER_PERIOD[l.recurrence] ? ` · ${ils(l.periodAmount)} ${PER_PERIOD[l.recurrence]}` : ""}
                </div>
              </div>
              <bdi style={{ color: DS.ink, whiteSpace: "nowrap" }}>{ils(l.monthly)} לחודש</bdi>
            </li>
          ))}
          {b.debtServiceLines.map((l) => (
            <li key={`d${l.commitmentId}`} style={excludedRow}>
              <span>{l.title} · החזר הלוואה, לא כלול</span>
              <bdi style={{ whiteSpace: "nowrap" }}>{ils(l.monthly)} לחודש</bdi>
            </li>
          ))}
          {oneOffs.map((u) => (
            <li key={`u${u.commitmentId}`} style={excludedRow}>
              <span>{u.title} · חד־פעמי, לא כלול</span>
              <bdi style={{ whiteSpace: "nowrap" }}>{ils(u.amount)}</bdi>
            </li>
          ))}
          {unreadable.map((u) => (
            <li key={`x${u.commitmentId}`} style={excludedRow}>
              <span>{u.title} · לא ניתן לחשב את המחזוריות, לא כלול</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!affirmed && lines.length > 0 ? (
        <div style={{ marginTop: 8, padding: "8px 10px", background: DS.surface2, borderRadius: 10, fontSize: 13, color: DS.ink }}>
          <span>רשמת את כל ההוצאות הקבועות של העסק? </span>
          <button type="button" onClick={affirm} disabled={affirming === "saving"} style={{ ...linkButton, marginTop: 0, fontWeight: 600 }}>
            {affirming === "saving" ? "שומר…" : "כן, רשמתי את כולן"}
          </button>
          {affirming === "failed" ? <div style={{ color: DS.tertiary, marginTop: 4 }}>לא הצלחתי לשמור. אפשר לנסות שוב.</div> : null}
        </div>
      ) : null}
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
      {gapLines.length > 0 ? <ReliabilityNote lines={gapLines.map((f) => f.text)} /> : null}
    </section>
  );
}

/** One of the two headline answers: a label, the number, and how it was reached. */
function Figure({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 0, background: DS.surface2, borderRadius: 12, padding: "10px 12px" }}>
      <div style={{ color: DS.muted, fontSize: 13 }}>{label}</div>
      <bdi style={{ display: "block", fontSize: 22, fontWeight: 700, color: DS.ink, whiteSpace: "nowrap" }}>{value}</bdi>
      <div style={{ color: DS.muted, fontSize: 12 }}>{hint}</div>
    </div>
  );
}

const excludedRow = { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderTop: `1px solid ${DS.line}`, color: DS.muted, fontSize: 13 } as const;

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
