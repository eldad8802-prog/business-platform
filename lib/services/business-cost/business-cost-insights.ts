/**
 * Business Cost insights — deterministic composition, no AI.
 *
 *   ledger truth → engine facts → signals (DETECTED only) → insight draft
 *
 * An insight is composed ONLY from a DETECTED signal. Every number in its text
 * is copied from the signal's evidence (never computed here from raw rows,
 * never estimated), and every insight carries the facts it was built from, the
 * period it compared, and the completeness of the data underneath. A signal
 * that is NONE or INSUFFICIENT_HISTORY produces no insight: silence is the
 * honest answer when nothing changed or when history is too short.
 *
 * An AI layer may later rephrase `body`; it may not change `facts`, which are
 * the source of truth for every figure the owner sees.
 */
import { fromMinorUnits } from "@/lib/services/payables/payables-core";
import type { BusinessCostSummary } from "./business-cost-intelligence";

export type CostInsightFact = {
  label: string;
  /** Decimal string in the base currency, or a civil date. */
  value: string;
  /** Where the value comes from: a signal field or a ledger row. */
  sourceRef: string;
};

export type CostInsight = {
  /** Stable per business + subject + period, so the same insight is never duplicated. */
  dedupeKey: string;
  kind: "BASELINE_RECURRING_COST_CHANGED" | "UPCOMING_PAYMENT_CONCENTRATION" | "CASH_OUT_OUTSIDE_OWN_RANGE";
  title: string;
  body: string;
  facts: CostInsightFact[];
  comparedPeriod: { from: string; to: string };
  /** Completeness of the cost data the insight stands on. */
  completeness: { state: string; reasons: string[] };
  why: string;
};

/** "3,050 ₪" — the Secretary's style; agorot only when there are any. */
const ils = (minor: number) => {
  const abs = Math.abs(minor);
  const frac = abs % 100 === 0 ? 0 : 2;
  return `${(abs / 100).toLocaleString("he-IL", { minimumFractionDigits: frac, maximumFractionDigits: frac })} ₪`;
};
const he = (date: string) => {
  const [y, m, d] = date.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
};

export function composeCostInsights(summary: BusinessCostSummary): CostInsight[] {
  const out: CostInsight[] = [];
  const completeness = summary.baseline.completeness;

  const b = summary.signals.baselineChange;
  if (b.state === "DETECTED") {
    const delta = b.monthlyToMinor - b.monthlyFromMinor;
    const main = b.drivers[0];
    const up = delta > 0;
    const facts: CostInsightFact[] = [
      { label: "עלות קבועה חודשית — לפני", value: fromMinorUnits(b.monthlyFromMinor), sourceRef: `signal:baselineChange.monthlyFrom@${b.from}` },
      { label: "עלות קבועה חודשית — עכשיו", value: fromMinorUnits(b.monthlyToMinor), sourceRef: `signal:baselineChange.monthlyTo@${b.to}` },
      { label: "עלות יומית ממוצעת — לפני", value: fromMinorUnits(b.dailyFromMinor), sourceRef: `signal:baselineChange.dailyFrom@${b.from}` },
      { label: "עלות יומית ממוצעת — עכשיו", value: fromMinorUnits(b.dailyToMinor), sourceRef: `signal:baselineChange.dailyTo@${b.to}` },
      ...b.drivers.map((d) => ({
        label: `${d.title} (${d.change === "ADDED" ? "נוסף" : d.change === "ENDED" ? "הסתיים" : "השתנה"})`,
        value: `${fromMinorUnits(d.monthlyFromMinor)} → ${fromMinorUnits(d.monthlyToMinor)}`,
        sourceRef: `commitment:${d.commitmentId}`,
      })),
    ];
    const change = summary.signals.recurringChange.changes.find(
      (c) => c.kind === "RECURRING_AMOUNT_CHANGED" && main && c.seriesKey === main.seriesKey,
    );
    const mainLine = !main
      ? ""
      : change && change.kind === "RECURRING_AMOUNT_CHANGED"
        ? `השינוי העיקרי שנרשם: ${main.title} — מ־${ils(change.fromMinor)} ל־${ils(change.toMinor)} החל מ־${he(change.effectiveDate)}. `
        : main.change === "ADDED"
          ? `השינוי העיקרי שנרשם: נוספה התחייבות קבועה — ${main.title} (${ils(main.monthlyToMinor)} לחודש). `
          : main.change === "ENDED"
            ? `השינוי העיקרי שנרשם: הסתיימה התחייבות קבועה — ${main.title} (${ils(main.monthlyFromMinor)} לחודש). `
            : `השינוי העיקרי שנרשם: ${main.title} — מ־${ils(main.monthlyFromMinor)} ל־${ils(main.monthlyToMinor)} לחודש. `;
    out.push({
      dedupeKey: `cost:baseline:${b.from}:${b.to}:${b.monthlyFromMinor}:${b.monthlyToMinor}`,
      kind: "BASELINE_RECURRING_COST_CHANGED",
      title: up ? `העלות הקבועה עלתה ב־${ils(delta)} לחודש` : `העלות הקבועה ירדה ב־${ils(delta)} לחודש`,
      body:
        `העלות הקבועה הידועה של העסק ${up ? "עלתה" : "ירדה"} מ־${ils(b.monthlyFromMinor)} ל־${ils(b.monthlyToMinor)} לחודש. ` +
        mainLine +
        `כך עלות יום פעילות ממוצע ${up ? "עולה" : "יורדת"} מ־${ils(b.dailyFromMinor)} ל־${ils(b.dailyToMinor)}.`,
      facts,
      comparedPeriod: { from: b.from, to: b.to },
      completeness,
      why: `השוואה בין העלות הקבועה ב־${he(b.from)} לבין ${he(b.to)}, מתוך ההתחייבויות שנרשמו.`,
    });
  }

  const u = summary.signals.upcomingConcentration;
  if (u.state === "DETECTED" && u.historyMaxMinor !== null) {
    out.push({
      dedupeKey: `cost:upcoming:${u.window.from}:${u.window.to}:${u.currentMinor}`,
      kind: "UPCOMING_PAYMENT_CONCENTRATION",
      title: "צפוי עומס תשלומים חריג ב־30 הימים הקרובים",
      body:
        `ב־30 הימים הקרובים צפויים לצאת ${ils(u.currentMinor)} — יותר מכל תקופה של 30 יום בשנה האחרונה של העסק ` +
        `(הגבוהה ביותר: ${ils(u.historyMaxMinor)}).`,
      facts: [
        { label: "צפוי ב־30 הימים הקרובים", value: fromMinorUnits(u.currentMinor), sourceRef: `signal:upcomingConcentration.current@${u.window.from}..${u.window.to}` },
        { label: "הגבוה ביותר בשנה האחרונה", value: fromMinorUnits(u.historyMaxMinor), sourceRef: "signal:upcomingConcentration.historyMax" },
        { label: "ממוצע תקופה", value: fromMinorUnits(u.historyMeanMinor ?? 0), sourceRef: "signal:upcomingConcentration.historyMean" },
      ],
      comparedPeriod: { from: u.history[0]?.from ?? u.window.from, to: u.window.to },
      completeness,
      why: `השוואה ל־${u.history.length} תקופות של 30 יום מההיסטוריה של העסק עצמו.`,
    });
  }

  const c = summary.signals.cashOut;
  if (c.state === "DETECTED" && c.direction === "ABOVE" && c.historyMaxMinor !== null) {
    out.push({
      dedupeKey: `cost:cashout:${c.window.from}:${c.window.to}:${c.currentMinor}`,
      kind: "CASH_OUT_OUTSIDE_OWN_RANGE",
      title: "יצא יותר כסף מהרגיל ב־30 הימים האחרונים",
      body:
        `ב־30 הימים האחרונים יצאו בפועל ${ils(c.currentMinor)}. ` +
        `זה יותר מכל תקופה של 30 יום בשנה האחרונה (הגבוהה ביותר: ${ils(c.historyMaxMinor)}).`,
      facts: [
        { label: "יצא בפועל ב־30 הימים האחרונים", value: fromMinorUnits(c.currentMinor), sourceRef: `signal:cashOut.current@${c.window.from}..${c.window.to}` },
        { label: "הגבוה ביותר בשנה האחרונה", value: fromMinorUnits(c.historyMaxMinor), sourceRef: "signal:cashOut.historyMax" },
      ],
      comparedPeriod: { from: c.history[0]?.from ?? c.window.from, to: c.window.to },
      completeness,
      why: `השוואה ל־${c.history.length} תקופות של 30 יום מההיסטוריה של העסק עצמו (תשלומים שנרשמו בלבד).`,
    });
  }
  return out;
}
