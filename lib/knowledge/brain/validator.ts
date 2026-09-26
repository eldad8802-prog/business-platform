/**
 * M8 · The deterministic grounding validator. Runs after EVERY model response. Pure.
 *
 * The model's output is untrusted until this passes. Nothing is repaired: an unsupported claim is
 * rejected, never re-asked. Policy:
 *   WHOLE RESULT rejected (INVALID_OUTPUT) — unparseable JSON, schema violation, wrong
 *     contextFingerprint (the answer is about some other context), or every finding rejected.
 *   ONE FINDING rejected — anything else below; the rest may stand.
 *
 * Checks, in order, per finding:
 *   refs exist in THIS context (K/F/C/G)             UNKNOWN_REF
 *   positive grounding in K or F (a gap is not one)  NO_POSITIVE_GROUNDING
 *   a cited gap is acknowledged as a limit           GAP_USED_AS_FACT
 *   limitation findings cite a gap                   LIMITATION_WITHOUT_GAP
 *   causalClaim false, no causal wording (he/en)     CAUSAL_CLAIM / CAUSAL_WORDING
 *   hypothesis null (not enabled in v1)              HYPOTHESIS_NOT_ENABLED
 *   every number in the text exists in cited facts   UNGROUNDED_NUMBER
 *   cited conflicts acknowledged as conflicts        CONFLICT_NOT_ACKNOWLEDGED
 *   identity language only with a linked-party F     FORBIDDEN_CONTENT
 *   no reference codes / technical jargon / length   FORBIDDEN_CONTENT / TEXT_TOO_LONG
 */
import { createHash } from "node:crypto";
import {
  FINDING_TYPES,
  PRIORITIES,
  UNCERTAINTY,
  type RawBrainFinding,
  type RawBrainResult,
  type RejectionCode,
  type ValidatedFinding,
} from "./brain.contract";
import type { AliasMap, BrainContext } from "./context-builder";
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";

const MAX_FINDINGS = 5;
const MAX_TEXT = 280;

/** Causal wording, English and Hebrew. Deliberately broad: a false rejection costs nothing. */
const CAUSAL = /\b(because|caused|causing|causes|due to|led to|leads to|result(?:s|ed)? in|as a result|driven by|owing to)\b|בגלל|גרמ|גורם ל|כתוצאה|עקב|הוביל|מוביל ל|בשל|מפני ש|משום ש|בעקבות|על רקע/i;
/** Identity assertions: allowed only when an authoritative linked-counterparty finding is cited. */
const IDENTITY = /\b(same (entity|supplier|vendor|business|company|counterparty)|is actually|is the same as)\b|אותו ספק|אותה ישות|אותו גורם|אותה חברה|זהה ל|הוא בעצם|הם אותו/i;
/** Internal vocabulary and reference codes never reach an owner. */
const JARGON = /\b[KFCGS]\d+\b|\b(median|baseline|iqr|mad|kendall|fingerprint|snapshot|knowledgeRef|slot)\b|חציון|קו בסיס/i;

const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

export function parseRawResult(text: string): RawBrainResult | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.contextFingerprint !== "string") return null;
  if (!["FINDINGS", "NO_ACTIONABLE_INSIGHT", "NOT_ENOUGH_KNOWLEDGE"].includes(o.outcome as string)) return null;
  if (!Array.isArray(o.findings)) return null;
  for (const f of o.findings as unknown[]) {
    if (!f || typeof f !== "object") return null;
    const x = f as Record<string, unknown>;
    const ok =
      typeof x.findingId === "string" && x.findingId.length > 0 && x.findingId.length <= 40 &&
      (FINDING_TYPES as readonly string[]).includes(x.type as string) &&
      (PRIORITIES as readonly string[]).includes(x.priority as string) &&
      (UNCERTAINTY as readonly string[]).includes(x.uncertainty as string) &&
      isStrArr(x.knowledgeRefs) && isStrArr(x.findingRefs) && isStrArr(x.conflictRefs) && isStrArr(x.gapRefs) &&
      typeof x.observation === "string" &&
      (x.interpretation === null || typeof x.interpretation === "string") &&
      (x.hypothesis === null || typeof x.hypothesis === "string") &&
      typeof x.causalClaim === "boolean";
    if (!ok) return null;
    const allowed = new Set(["findingId", "type", "priority", "knowledgeRefs", "findingRefs", "conflictRefs", "gapRefs",
      "observation", "interpretation", "hypothesis", "causalClaim", "uncertainty"]);
    if (Object.keys(x).some((k) => !allowed.has(k))) return null;
  }
  return o as unknown as RawBrainResult;
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
}

function numericFacts(facts: Record<string, unknown>): number[] {
  const out: number[] = [];
  for (const v of Object.values(facts)) if (typeof v === "number" && Number.isFinite(v)) out.push(v, Math.round(v), Math.abs(v), Math.round(Math.abs(v)));
  return out;
}

export type ValidationOutcome = {
  kind: "OK" | "INVALID_OUTPUT";
  outcome: RawBrainResult["outcome"] | null;
  accepted: ValidatedFinding[];
  rejected: { findingId: string | null; code: RejectionCode }[];
};

export function validateBrainOutput(
  text: string,
  expectedFingerprint: string,
  context: BrainContext,
  aliases: AliasMap,
  snapshot: BusinessKnowledgeSnapshot,
): ValidationOutcome {
  const raw = parseRawResult(text);
  if (!raw) return { kind: "INVALID_OUTPUT", outcome: null, accepted: [], rejected: [{ findingId: null, code: "SCHEMA_INVALID" }] };
  if (raw.contextFingerprint !== expectedFingerprint) {
    return { kind: "INVALID_OUTPUT", outcome: null, accepted: [], rejected: [{ findingId: null, code: "CONTEXT_FINGERPRINT_MISMATCH" }] };
  }

  const kByRef = new Map(context.knowledge.map((k) => [k.ref, k]));
  const fByRef = new Map(context.findings.map((f) => [f.ref, f]));
  const cByRef = new Map(context.conflicts.map((c) => [c.ref, c]));
  const gByRef = new Map(context.gaps.map((g) => [g.ref, g]));
  const snapFinding = new Map(snapshot.crossDomainFindings.map((f) => [f.slot, f]));

  const accepted: ValidatedFinding[] = [];
  const rejected: { findingId: string | null; code: RejectionCode }[] = [];
  const seen = new Set<string>();

  raw.findings.forEach((f: RawBrainFinding, i: number) => {
    const reject = (code: RejectionCode) => rejected.push({ findingId: f.findingId, code });
    if (i >= MAX_FINDINGS) return reject("TOO_MANY_FINDINGS");
    if (seen.has(f.findingId)) return reject("DUPLICATE_FINDING_ID");
    seen.add(f.findingId);

    if (f.knowledgeRefs.some((r) => !kByRef.has(r)) || f.findingRefs.some((r) => !fByRef.has(r)) ||
        f.conflictRefs.some((r) => !cByRef.has(r)) || f.gapRefs.some((r) => !gByRef.has(r))) return reject("UNKNOWN_REF");

    const positive = f.knowledgeRefs.length + f.findingRefs.length;
    if (f.type === "KNOWLEDGE_LIMITATION") {
      if (f.gapRefs.length === 0) return reject("LIMITATION_WITHOUT_GAP");
    } else if (positive === 0) {
      return reject("NO_POSITIVE_GROUNDING");
    }
    if (f.gapRefs.length > 0 && f.type !== "KNOWLEDGE_LIMITATION" && f.uncertainty === "SUPPORTED") return reject("GAP_USED_AS_FACT");

    if (f.causalClaim) return reject("CAUSAL_CLAIM");
    if (f.hypothesis !== null) return reject("HYPOTHESIS_NOT_ENABLED");

    const texts = [f.observation, f.interpretation ?? ""];
    if (f.observation.length === 0) return reject("FORBIDDEN_CONTENT");
    if (texts.some((t) => t.length > MAX_TEXT)) return reject("TEXT_TOO_LONG");
    if (texts.some((t) => CAUSAL.test(t))) return reject("CAUSAL_WORDING");
    if (texts.some((t) => JARGON.test(t))) return reject("FORBIDDEN_CONTENT");
    const citesLinkedParty = f.findingRefs.some((r) => fByRef.get(r)?.type === "LINKED_COUNTERPARTY_CONDITION");
    if (!citesLinkedParty && texts.some((t) => IDENTITY.test(t))) return reject("FORBIDDEN_CONTENT");

    // Every number the text states must come from what it cites.
    const allowedNums = new Set<number>([
      ...f.knowledgeRefs.flatMap((r) => numericFacts(kByRef.get(r)!.facts)),
      ...f.findingRefs.flatMap((r) => numericFacts(fByRef.get(r)!.facts)),
      ...f.gapRefs.flatMap((r) => [gByRef.get(r)!.subjectsAffected, gByRef.get(r)!.need ?? -1]),
    ]);
    if (texts.flatMap(numbersIn).some((n) => !allowedNums.has(n))) return reject("UNGROUNDED_NUMBER");

    // A cited knowledge item that sits in a conflict must be cited WITH its conflict, as a conflict.
    const requiredConflicts = new Set(f.knowledgeRefs.flatMap((r) => kByRef.get(r)!.conflictRefs));
    const conflictsNeeded = [...requiredConflicts].some((c) => !f.conflictRefs.includes(c));
    const unresolvedCited = f.conflictRefs.some((c) => cByRef.get(c)?.resolution === "UNRESOLVED");
    if (conflictsNeeded || (unresolvedCited && f.uncertainty !== "CONFLICT_PRESENT")) return reject("CONFLICT_NOT_ACKNOWLEDGED");

    const knowledgeSlots = f.knowledgeRefs.map((r) => aliases.knowledge.get(r)!.slot).sort();
    const findingSlots = f.findingRefs.map((r) => aliases.findings.get(r)!).sort();
    const conflictIds = f.conflictRefs.map((r) => aliases.conflicts.get(r)!).sort();
    const gapSlots = f.gapRefs.map((r) => aliases.gaps.get(r)!).sort();
    const subjects = new Map<string, { type: string; id: number | string }>();
    for (const r of f.knowledgeRefs) { const s = aliases.knowledge.get(r)!.subject; if (s) subjects.set(`${s.type}:${s.id}`, s); }
    for (const slot of findingSlots) { const s = snapFinding.get(slot)?.subject; if (s) subjects.set(`${s.type}:${s.id}`, s); }

    accepted.push({
      findingKey: createHash("sha256").update([f.type, ...knowledgeSlots, ...findingSlots, ...conflictIds, ...gapSlots].join("|")).digest("hex"),
      type: f.type, priority: f.priority, uncertainty: f.uncertainty,
      observation: f.observation, interpretation: f.interpretation,
      knowledgeSlots, findingSlots, conflictIds, gapSlots,
      subjects: [...subjects.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
    });
  });

  if (raw.findings.length > 0 && accepted.length === 0) {
    return { kind: "INVALID_OUTPUT", outcome: raw.outcome, accepted, rejected };
  }
  return { kind: "OK", outcome: raw.outcome, accepted, rejected };
}
