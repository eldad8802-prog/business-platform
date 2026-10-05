/**
 * Business Cost insights — Wave 1. Deterministic Hebrew, FACT level only. Pure.
 *
 * Built only from ACTIVE cost measures (COST-02/04/05) and gated by COST-08:
 *   - every number and date in the text is copied from the measure's own detail;
 *   - `interpretation` is always null and there is no suggested action — a fact is not promoted into
 *     a meaning (why it happened, good or bad, profit, affordability, intent);
 *   - when COST-08 reports gaps, the insight says the figures rest only on what was recorded.
 *
 * An entity is named only by the label the caller resolved for it inside the tenant; measures carry
 * no names.
 */
import type { ComposerInput, ContributingRule, FactLine, InsightDraft } from "./insight-composer";

type Measure = ComposerInput["activeMeasures"][number];
const D = (m: Measure) => (m.detail ?? {}) as Record<string, unknown>;

/** "3,050 ₪" — agorot only when there are any. */
export function money(minor: number): string {
  const abs = Math.abs(minor);
  const frac = abs % 100 === 0 ? 0 : 2;
  return `${(abs / 100).toLocaleString("he-IL", { minimumFractionDigits: frac, maximumFractionDigits: frac })} ₪`;
}
/** 2026-03-01 → 1/3/2026 */
export function date(civil: string): string {
  const [y, m, d] = civil.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}
function percentFromBp(bp: number): string {
  return `${(bp / 100).toLocaleString("he-IL", { maximumFractionDigits: 1 })}%`;
}

/** Gaps that make a figure rest on incomplete records — and that the owner can close. */
const RECORDING_GAPS = new Set(["UNALLOCATED_CASH", "DUE_WITHOUT_RECORDED_PAYMENT"]);

function completenessNote(input: ComposerInput): { uncertainty: string | null; rule: ContributingRule | null } {
  const c = input.activeMeasures.find((m) => m.measureKey === "payables.cost_data_completeness");
  if (!c) return { uncertainty: "לא ידוע עד כמה נתוני העלות של העסק מלאים.", rule: null };
  const gaps = (D(c).gaps as string[] | undefined) ?? [];
  const rule: ContributingRule = { ruleId: "COST-08", ruleVersion: c.ruleVersion, artifactKind: "measure", artifactRef: `knowledge-measure:${c.measureId}`, level: "FACT" };
  return { uncertainty: gaps.some((g) => RECORDING_GAPS.has(g)) ? "המספרים מבוססים רק על מה שנרשם, וחלק מנתוני העלות אינם מלאים." : null, rule };
}

function labelOf(input: ComposerInput, m: Measure): string {
  return input.entityLabels?.[`commitment:${m.entityId}`] ?? "התחייבות";
}

function draft(
  insightKey: string,
  dedupeKey: string,
  title: string,
  factLines: FactLine[],
  rules: ContributingRule[],
  uncertainty: string | null,
): InsightDraft {
  return {
    insightKey,
    dedupeKey,
    severity: "INFO",
    title,
    factLines,
    // FACT ≠ PATTERN ≠ MEANING: Wave-1 cost insights never carry an interpretation or a recommendation.
    interpretation: null,
    uncertainty,
    contributingRules: rules,
    suggestedActions: [],
  };
}

export function composeCostInsights(input: ComposerInput): InsightDraft[] {
  const note = completenessNote(input);
  const gate = note.rule ? [note.rule] : [];
  const out: InsightDraft[] = [];

  for (const m of input.activeMeasures) {
    const d = D(m);
    const ref = `knowledge-measure:${m.measureId}`;
    const rule = (ruleId: string): ContributingRule => ({ ruleId, ruleVersion: m.ruleVersion, artifactKind: "measure", artifactRef: ref, level: "FACT" });

    if (m.measureKey === "payables.recurring_amount_change" && m.entityId != null) {
      const label = labelOf(input, m);
      const lines: FactLine[] = [
        { text: `הסכום השתנה מ־${money(d.fromMinor as number)} ל־${money(d.toMinor as number)} החל מ־${date(d.effectiveDate as string)}`, sourceKind: "measure", sourceRef: ref },
      ];
      if (d.recurrence !== "MONTHLY") {
        lines.push({ text: `בחישוב חודשי: מ־${money(d.monthlyFromMinor as number)} ל־${money(d.monthlyToMinor as number)} לחודש`, sourceKind: "measure", sourceRef: ref });
      }
      lines.push({
        text: d.confirmation === "EXPLICIT_AMOUNT_CHANGE" ? "השינוי נרשם כשינוי סכום בהתחייבות" : `${d.occurrencesAtNewAmount as number} מועדים רצופים נרשמו בסכום החדש`,
        sourceKind: "measure",
        sourceRef: ref,
      });
      out.push(draft("cost.recurring_amount_changed", `cost.recurring_amount_changed:commitment:${m.entityId}:${d.effectiveDate}:${d.toMinor}`, `${label}: הסכום השתנה`, lines, [rule("COST-02"), ...gate], note.uncertainty));
    }

    if (m.measureKey === "payables.new_material_commitment" && m.entityId != null) {
      const label = labelOf(input, m);
      out.push(draft("cost.new_material_commitment", `cost.new_material_commitment:commitment:${m.entityId}:${d.firstDueDate}`, `נוספה התחייבות קבועה חדשה: ${label}`, [
        { text: `${money(d.monthlyMinor as number)} לחודש, החל מ־${date(d.firstDueDate as string)}`, sourceKind: "measure", sourceRef: ref },
        { text: `${percentFromBp(d.shareBp as number)} מהעלות הקבועה הידועה לפני שנוספה (${money(d.priorBaselineMonthlyMinor as number)} לחודש)`, sourceKind: "measure", sourceRef: ref },
      ], [rule("COST-04"), ...gate], note.uncertainty));
    }

    if (m.measureKey === "payables.ended_commitment" && m.entityId != null) {
      const label = labelOf(input, m);
      out.push(draft("cost.ended_commitment", `cost.ended_commitment:commitment:${m.entityId}:${d.endsOn}`, `התחייבות קבועה הסתיימה: ${label}`, [
        { text: `הסתיימה ב־${date(d.endsOn as string)}, לפי סיום שנרשם בהתחייבות`, sourceKind: "measure", sourceRef: ref },
        { text: `${money(d.monthlyRemovedMinor as number)} לחודש יצאו מהעלות הקבועה`, sourceKind: "measure", sourceRef: ref },
      ], [rule("COST-05"), ...gate], note.uncertainty));
    }
  }

  // ── Wave 2 · PATTERN — comparisons with this business's own covered history. Still no meaning:
  // what changed, compared with what, from which records. Never why, never good/bad, never affordability.
  for (const m of input.activeMeasures) {
    const d = D(m);
    if (d.detected !== true) continue;
    const ref = `knowledge-measure:${m.measureId}`;
    const rule = (ruleId: string): ContributingRule => ({ ruleId, ruleVersion: m.ruleVersion, artifactKind: "measure", artifactRef: ref, level: "PATTERN" });
    const line = (text: string): FactLine => ({ text, sourceKind: "measure", sourceRef: ref });

    if (m.measureKey === "payables.baseline_shift") {
      const up = (d.monthlyToMinor as number) > (d.monthlyFromMinor as number);
      const drivers = ((d.drivers ?? []) as Array<{ commitmentId: number; change: string; monthlyFromMinor: number; monthlyToMinor: number }>).slice(0, 3);
      const name = (id: number) => input.entityLabels?.[`commitment:${id}`] ?? "התחייבות";
      out.push(draft("cost.baseline_shift", `cost.baseline_shift:${d.monthlyFromMinor}:${d.monthlyToMinor}`,
        up ? "העלות הקבועה החודשית שנרשמה עלתה" : "העלות הקבועה החודשית שנרשמה ירדה", [
          line(`מ־${money(d.monthlyFromMinor as number)} לחודש (${date(d.comparedFrom as string)}) ל־${money(d.monthlyToMinor as number)} לחודש (${date(d.comparedTo as string)})`),
          ...drivers.map((x) => line(
            x.change === "ADDED" ? `נוספה: ${name(x.commitmentId)} (${money(x.monthlyToMinor)} לחודש)`
            : x.change === "ENDED" ? `הסתיימה: ${name(x.commitmentId)} (${money(x.monthlyFromMinor)} לחודש)`
            : `${name(x.commitmentId)}: מ־${money(x.monthlyFromMinor)} ל־${money(x.monthlyToMinor)} לחודש`)),
          line("הרמה החדשה נשמרת לפחות 30 יום"),
        ], [rule("COST-01"), ...gate], note.uncertainty));
    }

    if (m.measureKey === "payables.upcoming_concentration") {
      const w = d.window as { from: string; to: string };
      out.push(draft("cost.upcoming_concentration", `cost.upcoming_concentration:${w.from.slice(0, 7)}`,
        "ב־30 הימים הקרובים רשום לתשלום יותר מבכל תקופה קודמת שנבדקה", [
          line(`${money(d.currentMinor as number)} רשומים לתשלום עד ${date(w.to)}`),
          ...((d.projectedMinor as number) > 0 ? [line(`מתוכם ${money(d.projectedMinor as number)} לפי החזרתיות של התחייבויות קבועות`)] : []),
          line(`הגבוה ביותר ב־${d.coveredWindows as number} תקופות קודמות של 30 יום שנבדקו: ${money(d.historyMaxMinor as number)}`),
        ], [rule("COST-06"), ...gate], note.uncertainty));
    }

    if (m.measureKey === "payables.cash_out_above_range") {
      const w = d.window as { from: string; to: string };
      const largest = ((d.largestPayments ?? []) as Array<{ amountMinor: number }>)[0];
      out.push(draft("cost.cash_out_above_range", `cost.cash_out_above_range:${w.to.slice(0, 7)}`,
        "ב־30 הימים האחרונים נרשם יותר כסף יוצא מבכל תקופה קודמת שנבדקה", [
          line(`${money(d.currentMinor as number)} נרשמו כתשלומים בין ${date(w.from)} ל־${date(w.to)}`),
          line(`הגבוה ביותר ב־${d.coveredWindows as number} תקופות קודמות של 30 יום שנבדקו: ${money(d.historyMaxMinor as number)}`),
          ...(largest ? [line(`התשלום הגדול ביותר בתקופה: ${money(largest.amountMinor)}`)] : []),
        ], [rule("COST-07"), ...gate], note.uncertainty));
    }
  }

  // COST-08 itself: said only when something concrete is missing.
  const c = input.activeMeasures.find((m) => m.measureKey === "payables.cost_data_completeness");
  if (c) {
    const d = D(c);
    const gaps = [...((d.gaps as string[] | undefined) ?? [])].sort();
    const comp = (d.components ?? {}) as Record<string, number>;
    const windows = (d.windows ?? []) as Array<{ dueMinor: number; paidOfDueMinor: number }>;
    const ref = `knowledge-measure:${c.measureId}`;
    // Only gaps the OWNER can close are composed — each line tagged with its gap code (sourceRef "#CODE")
    // so a consumer never has to parse wording. Foreign currency and an unconfirmed backbone stay in
    // the COST-08 measure: the gate keeps working on them silently, with nothing to tell the owner.
    const lines: FactLine[] = [];
    const shown: string[] = [];
    for (const g of gaps) {
      const add = (text: string) => { lines.push({ text, sourceKind: "measure", sourceRef: `${ref}#${g}` }); shown.push(g); };
      if (g === "UNALLOCATED_CASH") add(`${money(comp.recentUnallocatedCashMinor)} מהתשלומים ב־${comp.recentDays} הימים האחרונים לא שויכו להתחייבות שנרשמה`);
      if (g === "DUE_WITHOUT_RECORDED_PAYMENT" && windows[0]) add(`מתוך ${money(windows[0].dueMinor)} שהגיעו למועד בתקופה הקודמת, נרשמו תשלומים על ${money(windows[0].paidOfDueMinor)}`);
      if (g === "ONE_OFF_COVERAGE_UNKNOWN") add(comp.uncertainOneOffCount === 1 ? "להוצאה חד־פעמית אחת לא נרשם לאיזו תקופה היא שייכת" : `ל־${comp.uncertainOneOffCount} הוצאות חד־פעמיות לא נרשם לאיזו תקופה הן שייכות`);
    }
    if (lines.length > 0) {
      out.push(draft("cost.data_completeness", `cost.data_completeness:${shown.join(",")}`, "חלק מנתוני העלות אינם מלאים", lines, [{ ruleId: "COST-08", ruleVersion: c.ruleVersion, artifactKind: "measure", artifactRef: ref, level: "FACT" }], null));
    }
  }
  return out;
}
