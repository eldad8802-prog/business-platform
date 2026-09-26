/**
 * M8 · Context builder — bks.v1 in, the minimum the model needs out. DETERMINISTIC, not a summarizer.
 *
 * What leaves Dubiz (the outbound AI data contract, see docs/learning/DUBIZ_BRAIN.md):
 *   - knowledge / findings / conflicts / gaps, each under an opaque alias (K1, F1, C1, G1)
 *   - subjects as opaque aliases (S1…) — never a database id, never a name or label
 *   - kinds, domains, rule keys, authority classes, statuses, freshness, caveats
 *   - counts, durations, rates, directions — NEVER a money amount (stripped, not rounded)
 * What never leaves: names, phones, emails, tax ids, text, notes, payloads, row ids, provenance,
 * evidence fingerprints, the businessId itself.
 *
 * What is excluded, and COUNTED in `omitted` so the model knows its view is partial:
 *   - STALE (not fresh) knowledge                    — cannot support a current statement
 *   - PROPOSED / REJECTED relationships              — never usable as identity
 *   - anything beyond the budget, lowest priority first, by a fixed product ordering
 *
 * The builder never guesses materiality. Priority uses only what the deterministic system already
 * states: knowledge kind, fact severity/category, freshness, and slot order.
 */
import { createHash } from "node:crypto";
import type { BusinessKnowledgeSnapshot, KnowledgeItem } from "../snapshot/snapshot.contract";

export const CONTEXT_VERSION = "brain-ctx.v1";

export const CONTEXT_BUDGET = {
  knowledge: 60,
  findings: 20,
  conflicts: 20,
  gaps: 30,
  /** Serialized bytes of the whole context. Knowledge is trimmed, lowest priority first, to fit. */
  bytes: 24_000,
} as const;

export type ContextKnowledge = {
  ref: string;
  kind: string;
  domain: string;
  subject: string | null;
  key: string;
  authority: string;
  facts: Record<string, string | number | boolean | null>;
  caveats: string[];
  conflictRefs: string[];
};

export type BrainContext = {
  contextVersion: typeof CONTEXT_VERSION;
  asOf: string;
  knowledge: ContextKnowledge[];
  findings: { ref: string; type: string; domains: string[]; subject: string; establishes: string; causal: false;
    facts: Record<string, string | number | boolean | null>; premiseRefs: string[]; caveats: string[] }[];
  conflicts: { ref: string; kind: string; resolution: string; prevailing: string | null; sideAuthorities: string[] }[];
  gaps: { ref: string; domain: string; key: string; kind: string; reason: string; subjectsAffected: number; need: number | null }[];
  omitted: Record<string, number>;
};

/** The server-side map from aliases back to snapshot terms. Never sent. */
export type AliasMap = {
  knowledge: Map<string, KnowledgeItem>;
  findings: Map<string, string>;
  conflicts: Map<string, string>;
  gaps: Map<string, string>;
  subjects: Map<string, { type: string; id: number | string }>;
};

const MONEY_KEYS = /amount|outstanding|unpaid|total|price|cost|charge|sum/i;

function stable(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Scalar = string | number | boolean | null;
const scalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Per-kind whitelist of what a knowledge item may say to the model. Money never passes. */
function factsOf(item: KnowledgeItem): Record<string, Scalar> {
  const v = item.value as Record<string, unknown>;
  const money = (v.unit === "currency") || (v.valueKind === "amount");
  const out: Record<string, Scalar> = {};
  const put = (k: string, x: unknown) => { if (scalar(x) && !(money && typeof x === "number")) out[k] = x; };
  const inner = (o: unknown) => (o && typeof o === "object" ? (o as Record<string, unknown>) : {});
  switch (item.kind) {
    case "MEASURE":
      put("unit", v.unit); if (!money) put("value", v.value == null ? null : Number(v.value)); put("trend", v.trend);
      break;
    case "BASELINE":
    case "STABLE_PATTERN":
      put("unit", v.unit); put("context", v.contextKey || null);
      if (!money) { put("median", inner(v.baseline).median); put("q1", inner(v.baseline).q1); put("q3", inner(v.baseline).q3); }
      put("observations", inner(v.baseline).n);
      break;
    case "TREND":
      put("unit", v.unit); put("direction", inner(v.finding).direction);
      break;
    case "MATERIAL_CHANGE":
      put("unit", v.unit); put("direction", inner(v.finding).direction);
      if (!money) { put("fromMedian", inner(v.baseline).median); put("toMedian", inner(v.recent).median); }
      break;
    case "ANOMALY": {
      const f = inner(v.finding);
      const obs = Array.isArray(f.observations) ? (f.observations as Record<string, unknown>[]) : [];
      put("unit", v.unit); put("unusualObservations", obs.length);
      put("directions", [...new Set(obs.map((o) => String(o.direction)))].sort().join(",") || null);
      const miss = inner(f.expectedOccurrenceMissing);
      if (Object.keys(miss).length > 0) { put("daysSinceLastOccurrence", miss.daysSinceLast); put("typicalGapDays", miss.typicalGap); }
      break;
    }
    case "FACT":
      put("category", v.category); put("severity", v.severity); put("moneyImpactBand", v.moneyImpactBand); put("blocking", v.blocking);
      break;
    case "CLAIM":
      put("candidates", Array.isArray(v.candidates) ? (v.candidates as unknown[]).length : null);
      break;
    case "OWNER_DECISION":
      put("decision", v.decision);
      break;
  }
  return out;
}

const KIND_RANK: Record<string, number> = {
  ANOMALY: 0, MATERIAL_CHANGE: 1, TREND: 2, FACT: 3, MEASURE: 5, STABLE_PATTERN: 6, BASELINE: 7, OWNER_DECISION: 8, CLAIM: 9,
};
function rank(item: KnowledgeItem): number {
  if (item.kind !== "FACT") return KIND_RANK[item.kind] ?? 10;
  const v = item.value as { category?: string; severity?: string };
  const urgent = (v.category === "ACTION_REQUIRED" || v.category === "ALERT") && (v.severity === "CRITICAL" || v.severity === "HIGH");
  return urgent ? 3 : 4;
}

export function buildBrainContext(snapshot: BusinessKnowledgeSnapshot): { context: BrainContext; aliases: AliasMap; fingerprint: string; bytes: number } {
  const omitted: Record<string, number> = {};
  const omit = (reason: string, n = 1) => { if (n > 0) omitted[reason] = (omitted[reason] ?? 0) + n; };

  const subjects = new Map<string, { type: string; id: number | string }>();
  const subjectAlias = new Map<string, string>();
  const aliasSubject = (s: { type: string; id: number | string } | null): string | null => {
    if (!s) return null;
    const key = `${s.type}:${s.id}`;
    if (!subjectAlias.has(key)) {
      const a = `S${subjectAlias.size + 1}`;
      subjectAlias.set(key, a);
      subjects.set(a, s);
    }
    return subjectAlias.get(key)!;
  };

  // Fresh knowledge only, in a fixed priority order.
  const fresh = snapshot.knowledge.filter((k) => k.freshness.fresh);
  omit("STALE_KNOWLEDGE", snapshot.knowledge.length - fresh.length);
  const ordered = [...fresh].sort((a, b) => rank(a) - rank(b) || a.slot.localeCompare(b.slot));
  omit("PROPOSED_OR_REJECTED_RELATIONSHIP", snapshot.relationships.filter((r) => r.status !== "ACTIVE").length);
  omit("TRUNCATED_BY_SNAPSHOT", Object.values(snapshot.stats?.truncated ?? {}).reduce((a, b) => a + b, 0));

  const conflictSlice = snapshot.conflicts.slice(0, CONTEXT_BUDGET.conflicts);
  omit("CONFLICT_OVER_BUDGET", snapshot.conflicts.length - conflictSlice.length);
  const conflictRef = new Map(conflictSlice.map((c, i) => [c.conflictId, `C${i + 1}`]));

  const gapSlice = snapshot.knowledgeGaps.slice(0, CONTEXT_BUDGET.gaps);
  omit("GAP_OVER_BUDGET", snapshot.knowledgeGaps.length - gapSlice.length);

  const findingSlice = snapshot.crossDomainFindings.slice(0, CONTEXT_BUDGET.findings);
  omit("FINDING_OVER_BUDGET", snapshot.crossDomainFindings.length - findingSlice.length);

  let knowledgeSlice = ordered.slice(0, CONTEXT_BUDGET.knowledge);
  omit("KNOWLEDGE_OVER_COUNT_BUDGET", ordered.length - knowledgeSlice.length);

  const assemble = (ks: KnowledgeItem[]) => {
    subjects.clear(); subjectAlias.clear();
    const kAlias = new Map(ks.map((k, i) => [k.slot, `K${i + 1}`]));
    const knowledge: ContextKnowledge[] = ks.map((k, i) => ({
      ref: `K${i + 1}`, kind: k.kind, domain: k.domain, subject: aliasSubject(k.subject), key: k.key,
      authority: k.authority, facts: factsOf(k), caveats: [...k.caveats],
      conflictRefs: k.conflictIds.map((c) => conflictRef.get(c)).filter((x): x is string => !!x).sort(),
    }));
    const findings = findingSlice.map((f, i) => {
      const facts: Record<string, Scalar> = {};
      for (const [key, val] of Object.entries(f.value)) {
        if (scalar(val) && !MONEY_KEYS.test(key) && typeof val !== "string") facts[key] = val;
        else if (key === "payablesExposure" && val && typeof val === "object") {
          for (const [ek, ev] of Object.entries(val as Record<string, unknown>)) if (scalar(ev) && !MONEY_KEYS.test(ek) && typeof ev === "number") facts[`payables_${ek}`] = ev;
        } else if (key === "knowledgeByDomain" && val && typeof val === "object") {
          facts.domainsWithKnowledge = Object.keys(val).length;
        }
      }
      return {
        ref: `F${i + 1}`, type: f.type, domains: [...f.domains], subject: aliasSubject(f.subject)!, establishes: f.establishes,
        causal: false as const, facts,
        premiseRefs: f.premises.map((p) => kAlias.get(p.slot)).filter((x): x is string => !!x).sort(),
        caveats: [...f.caveats],
      };
    });
    const conflicts = conflictSlice.map((c) => ({
      ref: conflictRef.get(c.conflictId)!, kind: c.kind, resolution: c.resolution, prevailing: c.prevailing,
      sideAuthorities: c.sides.map((s) => s.authority).sort(),
    }));
    const gaps = gapSlice.map((g, i) => ({
      ref: `G${i + 1}`, domain: g.domain, key: g.key, kind: g.kind, reason: g.reason, subjectsAffected: g.subjectsAffected, need: g.need,
    }));
    return { knowledge, findings, conflicts, gaps, kAlias };
  };

  let built = assemble(knowledgeSlice);
  let context: BrainContext = { contextVersion: CONTEXT_VERSION, asOf: snapshot.asOf, knowledge: built.knowledge,
    findings: built.findings, conflicts: built.conflicts, gaps: built.gaps, omitted };
  // Byte budget: drop the lowest-priority knowledge (the tail of the fixed order) until it fits.
  while (stable(context).length > CONTEXT_BUDGET.bytes && knowledgeSlice.length > 0) {
    knowledgeSlice = knowledgeSlice.slice(0, -1);
    omit("KNOWLEDGE_OVER_BYTE_BUDGET");
    built = assemble(knowledgeSlice);
    context = { ...context, knowledge: built.knowledge, findings: built.findings, conflicts: built.conflicts, gaps: built.gaps, omitted };
  }

  const aliases: AliasMap = {
    knowledge: new Map(knowledgeSlice.map((k, i) => [`K${i + 1}`, k])),
    findings: new Map(findingSlice.map((f, i) => [`F${i + 1}`, f.slot])),
    conflicts: new Map(conflictSlice.map((c) => [conflictRef.get(c.conflictId)!, c.conflictId])),
    gaps: new Map(gapSlice.map((g, i) => [`G${i + 1}`, g.slot])),
    subjects: new Map(subjects),
  };
  const serialized = stable(context);
  return { context, aliases, fingerprint: sha(serialized), bytes: serialized.length };
}

export { stable as stableSerialize };
