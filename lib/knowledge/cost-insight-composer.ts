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

const RECORDING_GAPS = new Set(["UNALLOCATED_CASH", "DUE_WITHOUT_RECORDED_PAYMENT", "BACKBONE_NOT_AFFIRMED"]);

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

  // COST-08 itself: said only when something concrete is missing.
  const c = input.activeMeasures.find((m) => m.measureKey === "payables.cost_data_completeness");
  if (c) {
    const d = D(c);
    const gaps = [...((d.gaps as string[] | undefined) ?? [])].sort();
    const comp = (d.components ?? {}) as Record<string, number>;
    const windows = (d.windows ?? []) as Array<{ dueMinor: number; paidOfDueMinor: number }>;
    const ref = `knowledge-measure:${c.measureId}`;
    const lines: FactLine[] = [];
    for (const g of gaps) {
      if (g === "UNALLOCATED_CASH") lines.push({ text: `${money(comp.recentUnallocatedCashMinor)} מהתשלומים ב־${comp.recentDays} הימים האחרונים אינם משויכים להתחייבות שנרשמה`, sourceKind: "measure", sourceRef: ref });
      if (g === "DUE_WITHOUT_RECORDED_PAYMENT" && windows[0]) lines.push({ text: `בתקופת 30 הימים האחרונה שנבדקה נרשם תשלום ל־${money(windows[0].paidOfDueMinor)} מתוך ${money(windows[0].dueMinor)} שהגיעו למועדם`, sourceKind: "measure", sourceRef: ref });
      if (g === "ONE_OFF_COVERAGE_UNKNOWN") lines.push({ text: `${comp.uncertainOneOffCount} הוצאות חד־פעמיות בלי תקופה ידועה אינן נכללות בעלות הקבועה`, sourceKind: "measure", sourceRef: ref });
      if (g === "FOREIGN_CURRENCY_EXCLUDED") lines.push({ text: `${comp.foreignCurrencySeries} התחייבויות במטבע זר אינן נכללות`, sourceKind: "measure", sourceRef: ref });
      if (g === "BACKBONE_NOT_AFFIRMED") lines.push({ text: "עדיין לא אושר שכל ההוצאות הקבועות נרשמו", sourceKind: "measure", sourceRef: ref });
    }
    if (lines.length > 0) {
      lines.push({ text: `היסטוריית עלות שאפשר להסתמך עליה: ${d.trustworthyHistoryDays as number} ימים`, sourceKind: "measure", sourceRef: ref });
      out.push(draft("cost.data_completeness", `cost.data_completeness:${gaps.join(",")}`, "חלק מנתוני העלות אינם מלאים", lines, [{ ruleId: "COST-08", ruleVersion: c.ruleVersion, artifactKind: "measure", artifactRef: ref, level: "FACT" }], null));
    }
  }
  return out;
}
