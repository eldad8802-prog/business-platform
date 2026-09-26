/**
 * M8 · Owner-facing rendering — DETERMINISTIC. No model call, no new claim.
 *
 * The only model-authored text that reaches an owner is a validated finding's observation and
 * interpretation. Everything around it — the heading, what Dubiz does not know yet, the conflict
 * note — is fixed Hebrew chosen by type and by the cited gaps/conflicts. The renderer cannot add a
 * fact, a cause, a relationship or a recommendation, because it has no text of its own to add them in.
 */
import type { ValidatedFinding } from "./brain.contract";
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";

const HEADINGS: Record<ValidatedFinding["type"], string> = {
  ATTENTION: "דורש תשומת לב",
  CHANGE: "משהו השתנה",
  CROSS_DOMAIN_CONTEXT: "תמונה רחבה יותר",
  KNOWLEDGE_LIMITATION: "מה Dubiz עוד לא יודעת",
};

const GAP_PHRASES: Record<string, string> = {
  INSUFFICIENT_HISTORY: "עדיין אין מספיק היסטוריה כדי לדעת מה רגיל לעסק בנושא הזה.",
  INSUFFICIENT_EVIDENCE: "עדיין אין מספיק נתונים כדי לומר משהו בנושא הזה.",
  PREMISE_UNAVAILABLE: "חסר מידע מאומת כדי לחבר בין התחומים.",
  RULE_BLOCKED: "Dubiz עוד לא יכולה לדעת את זה באופן אמין.",
};

export type RenderedInsight = {
  readonly findingKey: string;
  readonly heading: string;
  readonly body: string;
  readonly limits: readonly string[];
  readonly conflictNote: string | null;
  /** The deterministic "why?" path: which knowledge this rests on (internal slots, not shown raw). */
  readonly why: { readonly knowledge: readonly string[]; readonly findings: readonly string[]; readonly gaps: readonly string[] };
};

export function renderFinding(f: ValidatedFinding, snapshot: BusinessKnowledgeSnapshot): RenderedInsight {
  const gapKinds = new Set(f.gapSlots.map((s) => snapshot.knowledgeGaps.find((g) => g.slot === s)?.kind).filter((k): k is NonNullable<typeof k> => !!k));
  return {
    findingKey: f.findingKey,
    heading: HEADINGS[f.type],
    body: f.interpretation ? `${f.observation} ${f.interpretation}` : f.observation,
    limits: [...gapKinds].sort().map((k) => GAP_PHRASES[k] ?? GAP_PHRASES.INSUFFICIENT_EVIDENCE),
    conflictNote: f.uncertainty === "CONFLICT_PRESENT"
      ? "ל-Dubiz יש מידע סותר בנושא הזה, ולכן אף אחד מהערכים לא נחשב סופי."
      : null,
    why: { knowledge: f.knowledgeSlots, findings: f.findingSlots, gaps: f.gapSlots },
  };
}

/**
 * Is a validated finding still CURRENT against a newer snapshot? Only if every piece of knowledge,
 * every finding and every conflict it cites still exists there. A reversed, stale or superseded
 * premise leaves the snapshot, so the finding stops being current — without any model call.
 */
export function isStillCurrent(f: ValidatedFinding, current: BusinessKnowledgeSnapshot): boolean {
  const k = new Set(current.knowledge.map((i) => i.slot));
  const fs = new Set(current.crossDomainFindings.map((i) => i.slot));
  const cs = new Set(current.conflicts.map((c) => c.conflictId));
  return f.knowledgeSlots.every((s) => k.has(s)) && f.findingSlots.every((s) => fs.has(s)) && f.conflictIds.every((c) => cs.has(c));
}
