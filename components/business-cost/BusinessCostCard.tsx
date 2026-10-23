"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Locale } from "@/lib/i18n/config";
import { formatAmount } from "@/lib/i18n/format";
import { moneyHe } from "@/lib/i18n/messages/areas/money";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import {
  affirmRecurringCostsRecorded,
  fetchBusinessCostSummary,
  fetchLearnedCostInsights,
  type BusinessCostSummaryApi,
  type LearnedCostInsightApi,
} from "@/lib/business-cost/business-cost-client";

const DS = TOKEN.dsv1;

/**
 * The Secretary's own style: "3,050 ₪", agorot only when there are any. The engine reports in the
 * business's base currency (ILS; non-base rows are excluded upstream), so the symbol is not a default
 * guess. Other interface languages use the shared formatter, same currency, same digits. Exported for the
 * Secretary hub's day-cost card, so the card and this breakdown show the figure the same way.
 */
export const formatIls = (decimal: string, locale: Locale) => {
  const n = Number(decimal);
  const frac = Number.isInteger(n) ? 0 : 2;
  if (locale !== "he") return formatAmount(n, "ILS", { locale }, { fixedFraction: frac > 0 });
  return `${n.toLocaleString("he-IL", { minimumFractionDigits: frac, maximumFractionDigits: frac })} ₪`;
};

/** Learned insights shown at once; the rest open on demand. The card is a summary, not a feed. */
const VISIBLE_INSIGHTS = 2;

/**
 * Data gaps the owner can act on. Others (an unconfirmed backbone, foreign currency) stay in the gate, silently;
 * one-offs without a period are already listed under the monthly cost as "not included".
 */
const ACTIONABLE_GAP = /#(UNALLOCATED_CASH|DUE_WITHOUT_RECORDED_PAYMENT)$/;

/** "2026-10" → "אוקטובר". From the server's business-local month, never the browser clock. */
const monthName = (tr: Translator, month: string) => {
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12 ? tr(`money.businessCost.months.m${m}` as MessageKey) : "";
};
/** "2026-10-02" → "2/10/2026". */
const heDate = (civil: string) => {
  const [y, m, d] = civil.split("-").map(Number);
  return `${d}/${m}/${y}`;
};
/** How often the owner pays it, as recorded (labels in the money dictionary). */
const hasKey = (map: object, k: string) => Object.prototype.hasOwnProperty.call(map, k);
const cadenceName = (tr: Translator, r: string) =>
  hasKey(moneyHe.businessCost.cadence, r) ? tr(`money.businessCost.cadence.${r}` as MessageKey) : undefined;
const perPeriod = (tr: Translator, r: string) =>
  hasKey(moneyHe.businessCost.perPeriod, r) ? tr(`money.businessCost.perPeriod.${r}` as MessageKey) : undefined;

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
/**
 * `embedded`: no top margin, for a side column that sets its own gaps. `breakdownOpen`: start with the
 * breakdown shown (the Secretary's day-cost drawer). Content is unchanged either way.
 */
export function BusinessCostCard({ embedded = false, breakdownOpen = false }: { embedded?: boolean; breakdownOpen?: boolean } = {}) {
  const { t: tr, locale } = useI18n();
  const ils = (decimal: string) => formatIls(decimal, locale);
  const [summary, setSummary] = useState<BusinessCostSummaryApi | null>(null);
  const [learned, setLearned] = useState<LearnedCostInsightApi[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(breakdownOpen);
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
    b.debtServiceLines.length > 0 ? tr("money.businessCost.loansPerMonth", { amount: ils(b.debtServiceMonthly) }) : null,
    oneOffs.length === 1 ? tr("money.businessCost.oneOffOne") : oneOffs.length > 1 ? tr("money.businessCost.oneOffMany", { count: oneOffs.length }) : null,
    unreadable.length === 1
      ? tr("money.businessCost.unreadableOne")
      : unreadable.length > 1
        ? tr("money.businessCost.unreadableMany", { count: unreadable.length })
        : null,
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
      aria-label={tr("money.businessCost.title")}
      style={{
        // Rendered inside the Secretary main screen, in its column.
        marginTop: embedded ? 0 : 16,
        width: "100%",
        boxSizing: "border-box",
        background: DS.card,
        border: `1px solid ${DS.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 17, color: DS.ink }}>{tr("money.businessCost.title")}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Figure
          label={tr("money.businessCost.monthlyFixed")}
          value={ils(b.monthly)}
          hint={
            affirmed
              ? affirmedOn
                ? tr("money.businessCost.affirmedOn", { date: heDate(affirmedOn) })
                : tr("money.businessCost.affirmedAll")
              : tr("money.businessCost.perRecorded")
          }
        />
        <Figure
          label={tr("money.businessCost.dailyIn", { month: monthName(tr, b.calendarDay.month) })}
          value={ils(b.calendarDay.daily)}
          // "חלקי", not "÷": a neutral symbol between two numbers is reordered by the RTL line; a Hebrew word is not.
          hint={tr("money.businessCost.dailyHint", { monthly: ils(b.monthly), days: b.calendarDay.daysInMonth })}
        />
      </div>
      {notIncluded.length > 0 ? (
        <div style={{ marginTop: 6, color: DS.muted, fontSize: 13 }}>
          {tr("money.businessCost.notIncluded")}{" "}
          {notIncluded.map((t, k) => (
            <span key={t} style={{ whiteSpace: "nowrap" }}>
              {k > 0 ? " · " : ""}
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <button type="button" onClick={() => setShowBreakdown((v) => !v)} aria-expanded={showBreakdown} style={linkButton}>
        {showBreakdown ? tr("money.businessCost.hideBreakdown") : tr("money.businessCost.showBreakdown")}
      </button>
      {showBreakdown ? (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 14 }}>
          {lines.map((l) => (
            <li key={l.commitmentId} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderTop: `1px solid ${DS.line}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: DS.ink }}>{l.title}</div>
                <div style={{ color: DS.muted, fontSize: 12 }}>
                  {cadenceName(tr, l.recurrence) ?? tr("money.businessCost.recurringFallback")}
                  {perPeriod(tr, l.recurrence)
                    ? ` · ${tr("money.businessCost.periodAmount", { amount: ils(l.periodAmount), period: perPeriod(tr, l.recurrence) ?? "" })}`
                    : ""}
                </div>
              </div>
              <bdi style={{ color: DS.ink, whiteSpace: "nowrap" }}>{tr("money.businessCost.perMonth", { amount: ils(l.monthly) })}</bdi>
            </li>
          ))}
          {b.debtServiceLines.map((l) => (
            <li key={`d${l.commitmentId}`} style={excludedRow}>
              <span>{tr("money.businessCost.loanExcluded", { title: l.title })}</span>
              <bdi style={{ whiteSpace: "nowrap" }}>{tr("money.businessCost.perMonth", { amount: ils(l.monthly) })}</bdi>
            </li>
          ))}
          {oneOffs.map((u) => (
            <li key={`u${u.commitmentId}`} style={excludedRow}>
              <span>{tr("money.businessCost.oneOffExcluded", { title: u.title })}</span>
              <bdi style={{ whiteSpace: "nowrap" }}>{ils(u.amount)}</bdi>
            </li>
          ))}
          {unreadable.map((u) => (
            <li key={`x${u.commitmentId}`} style={excludedRow}>
              <span>{tr("money.businessCost.unreadableExcluded", { title: u.title })}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!affirmed && lines.length > 0 ? (
        <div style={{ marginTop: 8, padding: "8px 10px", background: DS.surface2, borderRadius: 10, fontSize: 13, color: DS.ink }}>
          <span>{tr("money.businessCost.affirmQuestion")} </span>
          <button type="button" onClick={affirm} disabled={affirming === "saving"} style={{ ...linkButton, marginTop: 0, fontWeight: 600 }}>
            {affirming === "saving" ? tr("money.common.saving") : tr("money.businessCost.affirmYes")}
          </button>
          {affirming === "failed" ? <div style={{ color: DS.tertiary, marginTop: 4 }}>{tr("money.businessCost.saveFailed")}</div> : null}
        </div>
      ) : null}
      {row(tr("money.businessCost.outToday"), ils(summary.periods.today.cashOut), tr("money.businessCost.thisMonth", { amount: ils(summary.periods.thisMonth.cashOut) }))}
      {row(tr("money.businessCost.next7"), ils(summary.upcoming.next7Days.total), tr("money.businessCost.in30", { amount: ils(summary.upcoming.next30Days.total) }))}
      {overdue ? row(tr("money.businessCost.overdue"), ils(summary.upcoming.overdue.total)) : null}
      {changes.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15, color: DS.ink }}>{tr("money.businessCost.changesTitle")}</h3>
          {visible.map((i) => (
            <LearnedInsight key={i.id} insight={i} />
          ))}
          {changes.length > VISIBLE_INSIGHTS ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} style={linkButton}>
              {showAll
                ? tr("money.businessCost.showLess")
                : changes.length - VISIBLE_INSIGHTS === 1
                  ? tr("money.businessCost.moreOne")
                  : tr("money.businessCost.moreMany", { count: changes.length - VISIBLE_INSIGHTS })}
            </button>
          ) : null}
        </div>
      ) : null}
      {gapLines.length > 0 ? <ReliabilityNote lines={gapLines.map((f) => f.text)} /> : null}
    </section>
  );
}

/** One of the two headline answers: a label, the number, and how it was reached. */
function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 0, background: DS.surface2, borderRadius: 12, padding: "10px 12px" }}>
      <div style={{ color: DS.muted, fontSize: 13 }}>{label}</div>
      <bdi style={{ display: "block", fontSize: 22, fontWeight: 700, color: DS.ink, whiteSpace: "nowrap" }}>{value}</bdi>
      <div style={{ color: DS.muted, fontSize: 12 }}>{hint}</div>
    </div>
  );
}

const excludedRow = { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderTop: `1px solid ${DS.line}`, color: DS.muted, fontSize: 13 } as const;

function LearnedInsight({ insight }: { insight: LearnedCostInsightApi }) {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const level = insight.contributingRules[0]?.level;
  const levelLabel = level && hasKey(moneyHe.businessCost.level, level) ? tr(`money.businessCost.level.${level}` as MessageKey) : null;
  return (
    <div style={{ marginTop: 8, background: DS.surface2, borderRadius: 12, padding: "10px 12px" }}>
      {levelLabel ? <div style={{ color: DS.muted, fontSize: 12 }}>{levelLabel}</div> : null}
      <div style={{ fontWeight: 600, color: DS.ink }}>{insight.title}</div>
      <div style={{ color: DS.ink, fontSize: 14, lineHeight: 1.6 }}>{insight.factLines[0]?.text}</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ marginTop: 4, padding: 0, border: 0, background: "none", color: DS.accent, fontSize: 13, cursor: "pointer", font: "inherit" }}
      >
        {open ? tr("money.businessCost.hide") : tr("money.businessCost.why")}
      </button>
      {open ? (
        <ul style={{ margin: "6px 0 0", paddingInlineStart: 18, color: DS.ink, fontSize: 13, lineHeight: 1.7 }}>
          {insight.factLines.slice(1).map((f, k) => (
            <li key={k}>{f.text}</li>
          ))}
          <li style={{ color: DS.muted }}>
            {insight.uncertainty ?? tr("money.businessCost.basedOnRecords")}
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function ReliabilityNote({ lines }: { lines: string[] }) {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "10px 0 0", color: DS.tertiary, fontSize: 13 }}>
      <span>{tr("money.businessCost.reliability")} </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ padding: 0, border: 0, background: "none", color: DS.accent, fontSize: 13, cursor: "pointer", font: "inherit" }}
      >
        {open ? tr("money.businessCost.hide") : tr("money.businessCost.whatMissing")}
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
