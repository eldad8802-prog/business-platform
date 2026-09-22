/**
 * M3 · The Dubiz Insight composer — deterministic, cross-domain, and explicitly not AI.
 *
 * WHAT AN INSIGHT IS HERE
 * A composition of things that are already TRUE, drawn from more than one domain, that together say
 * something none of them says alone. Nothing is inferred. There is no model, no scoring, no
 * correlation — those need a baseline that does not exist yet, and would need evidence volume this
 * business data does not have.
 *
 * That restraint is the design, not a limitation waiting to be removed.
 *
 * THREE LEVELS, AND ONLY THE FIRST IS AUTHORITATIVE
 *   FACTS           authoritative observations. Each one is true, and each points at the artifact it
 *                   came from, so it can be checked rather than believed.
 *   INTERPRETATION  what Dubiz makes of those facts together. Derived, and NOT authoritative.
 *   SUGGESTED ACTION a recommendation. The owner decides; nothing here acts.
 *
 * An earlier version of this comment claimed that "a composition of facts cannot be wrong". That is
 * false and worth correcting in place, because it is the kind of sentence that quietly becomes an
 * engineering assumption. Every fact can be correct while the interpretation joining them is wrong,
 * or irrelevant, or right about a situation the owner already handled — and the suggested action can
 * be wrong even when the interpretation is sound.
 *
 * What the structure actually buys is narrower and more useful: each level is separately
 * explainable, so a wrong interpretation can be identified AS an interpretation and rejected without
 * discrediting the facts underneath it. That separation is what will matter most when a reasoning
 * layer starts producing the middle level instead of this file.
 *
 * WHAT THE COMPOSER MAY NOT DO
 *   - claim causality ("because"), or that one thing LED to another;
 *   - consume knowledge that is not ACTIVE;
 *   - present interpretation as fact;
 *   - invent a number, including a confidence.
 *
 * Purity: this module takes inputs and returns a draft. It reads no database and no clock.
 */
import type { BusinessStatusItem } from "@/lib/business-status/types";

export const COMPOSER_VERSION = "insight-composer@1";

/** A statement that is TRUE, with the artifact it came from. */
export type FactLine = {
  readonly text: string;
  readonly sourceKind: "fact" | "measure";
  /** The artifact this line is derived from, so "why" can be walked rather than trusted. */
  readonly sourceRef: string;
};

export type ContributingRule = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly artifactKind: "fact" | "measure";
  readonly artifactRef: string;
};

export type InsightDraft = {
  readonly insightKey: string;
  readonly dedupeKey: string;
  readonly severity: string;
  readonly title: string;
  readonly factLines: readonly FactLine[];
  readonly interpretation: string | null;
  readonly uncertainty: string | null;
  readonly contributingRules: readonly ContributingRule[];
  readonly suggestedActions: readonly string[];
};

/** The knowledge the composer is allowed to see. Only ACTIVE measures ever reach it. */
export type ComposerInput = {
  readonly businessId: number;
  readonly facts: readonly BusinessStatusItem[];
  readonly activeMeasures: readonly {
    readonly measureKey: string;
    readonly valueNumeric: number;
    readonly valueUnit: string;
    readonly observationCount: number;
    readonly trend: string | null;
    readonly ruleVersion: string;
    readonly measureId: number;
  }[];
};

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1,
};

function highest(items: readonly BusinessStatusItem[]): string {
  return items.reduce(
    (acc, i) => ((SEVERITY_RANK[i.severity] ?? 0) > (SEVERITY_RANK[acc] ?? 0) ? i.severity : acc),
    "INFO",
  );
}

/**
 * MONEY-PRESSURE — the first composition.
 *
 * It fires when money is leaving the business under time pressure (an overdue or imminent payable) AND
 * the paperwork that would tell the owner where they stand is backed up. Each half is already visible
 * on its own; neither is alarming alone. Together they describe a specific, recognisable situation:
 * about to spend, with an incomplete picture.
 *
 * It requires TWO domains by construction — a single-domain composition would be a louder version of a
 * fact the owner already has, and there is no reason to say the same thing twice.
 */
export function composeMoneyPressure(input: ComposerInput): InsightDraft | null {
  const payables = input.facts.filter((f) => f.domain === "payables");
  const paperwork = input.facts.filter((f) => f.domain === "documents");
  if (payables.length === 0 || paperwork.length === 0) return null;

  const overdue = payables.filter((f) => f.itemId.startsWith("payables:overdue:"));
  const dueSoon = payables.filter((f) => f.itemId.startsWith("payables:due_soon:"));

  const factLines: FactLine[] = [];
  const rules: ContributingRule[] = [];

  if (overdue.length > 0) {
    factLines.push({
      text: `${overdue.length} תשלומים עברו את מועדם`,
      sourceKind: "fact",
      sourceRef: overdue.map((f) => f.itemId).join(","),
    });
    rules.push({ ruleId: "AP-L0-overdue", ruleVersion: "v1", artifactKind: "fact",
      artifactRef: overdue.map((f) => f.itemId).join(",") });
  }
  if (dueSoon.length > 0) {
    factLines.push({
      text: `${dueSoon.length} תשלומים מתקרבים`,
      sourceKind: "fact",
      sourceRef: dueSoon.map((f) => f.itemId).join(","),
    });
    rules.push({ ruleId: "AP-L0-due-soon", ruleVersion: "v1", artifactKind: "fact",
      artifactRef: dueSoon.map((f) => f.itemId).join(",") });
  }

  factLines.push({
    text: `${paperwork.length} מסמכים ממתינים לטיפול`,
    sourceKind: "fact",
    sourceRef: paperwork.map((f) => f.itemId).join(","),
  });
  rules.push({ ruleId: "DOC-L0-needs-review", ruleVersion: "v1", artifactKind: "fact",
    artifactRef: paperwork.map((f) => f.itemId).join(",") });

  // A measure joins ONLY if it is present and ACTIVE. The caller never passes anything else, and the
  // composer does not go looking — knowledge that has not earned ACTIVE is not knowledge here.
  const lag = input.activeMeasures.find((m) => m.measureKey === "documents.paperwork_lag");
  let interpretation: string | null = null;
  let uncertainty: string | null = null;

  if (lag) {
    factLines.push({
      text: `בדרך כלל מסמך מטופל אחרי ${lag.valueNumeric} ימים (מתוך ${lag.observationCount} מקרים)`,
      sourceKind: "measure",
      sourceRef: `knowledge-measure:${lag.measureId}`,
    });
    rules.push({ ruleId: "DOC-04", ruleVersion: lag.ruleVersion, artifactKind: "measure",
      artifactRef: `knowledge-measure:${lag.measureId}` });

    // Interpretation is allowed here, and it is carefully NOT causal: the paperwork habit does not
    // cause the payment pressure. It states a consequence of the two facts holding at once.
    interpretation =
      `לפי הקצב הרגיל שלך, חלק מהמסמכים האלה יטופלו רק אחרי מועד התשלום — כלומר ההחלטה על התשלום ` +
      `תתקבל לפני שהתמונה המלאה תהיה לפניך.`;
    uncertainty =
      `הקצב מבוסס על ${lag.observationCount} מקרים בלבד, והוא ממוצע — מסמך בודד עשוי להיות מטופל מהר יותר.`;
  } else {
    // No measure: the insight still stands on its facts, and says less rather than guessing.
    uncertainty = "עדיין אין מספיק היסטוריה כדי לדעת מה קצב הטיפול הרגיל שלך במסמכים.";
  }

  const suggestedActions = [
    "עבור על המסמכים הממתינים לפני אישור התשלומים",
    "בדוק אם אחד התשלומים שעבר מועדו כבר שולם בפועל",
  ];

  return {
    insightKey: "payables.pressure_with_paperwork_backlog",
    // Stable across regenerations: the same situation refreshes one row rather than breeding new ones.
    dedupeKey: "payables.pressure_with_paperwork_backlog",
    severity: highest([...payables, ...paperwork]),
    title: "תשלומים בלחץ זמן לצד ניירת שלא טופלה",
    factLines,
    interpretation,
    uncertainty,
    contributingRules: rules,
    suggestedActions,
  };
}

/** Every composition the system knows. One today; the list is the extension point. */
export const COMPOSERS: readonly ((input: ComposerInput) => InsightDraft | null)[] = [
  composeMoneyPressure,
];

export function composeInsights(input: ComposerInput): InsightDraft[] {
  return COMPOSERS.map((c) => c(input)).filter((d): d is InsightDraft => d !== null);
}
