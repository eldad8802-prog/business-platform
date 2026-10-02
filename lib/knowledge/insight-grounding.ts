/**
 * The AI grounding guard — kept for future waves, deliberately unused in Wave 1.
 *
 * Wave 1 owner-facing wording is deterministic only. When a later wave lets a model REPHRASE an
 * insight, the rephrasing is accepted only if it introduces nothing the insight's facts do not
 * already contain: no new number, no new date, no new entity. Anything else falls back to the
 * deterministic wording. A model may help an owner understand; it may not add a fact.
 *
 * Pure. Token-level, conservative: a false refusal costs a nicer sentence, a false acceptance costs
 * a fabricated figure — so the guard errs towards refusing.
 */

const DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function normaliseNumber(t: string): string {
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : t;
}

/** The checkable claims in a text: its dates and its numbers (dates first, so their digits are not re-read as numbers). */
export function factualTokens(text: string): { dates: string[]; numbers: string[] } {
  const dates = text.match(DATE) ?? [];
  const rest = text.replace(DATE, " ");
  const numbers = (rest.match(NUMBER) ?? []).map(normaliseNumber);
  return { dates, numbers };
}

export type GroundingViolation = { kind: "number" | "date" | "entity"; token: string };

/**
 * What a candidate text claims that its grounding does not.
 * `grounding` is the insight's own fact texts; `knownEntities` is every entity label the business has,
 * so a candidate naming a DIFFERENT commitment than its facts do is caught even though names are free text.
 */
export function ungroundedClaims(
  candidate: string,
  grounding: readonly string[],
  knownEntities: readonly string[] = [],
): GroundingViolation[] {
  const allowed = grounding.map(factualTokens);
  const allowedDates = new Set(allowed.flatMap((a) => a.dates));
  const allowedNumbers = new Set(allowed.flatMap((a) => a.numbers));
  const c = factualTokens(candidate);
  const out: GroundingViolation[] = [];
  for (const d of c.dates) if (!allowedDates.has(d)) out.push({ kind: "date", token: d });
  for (const n of c.numbers) if (!allowedNumbers.has(n)) out.push({ kind: "number", token: n });
  const groundText = grounding.join("\n");
  for (const e of knownEntities) {
    if (e && candidate.includes(e) && !groundText.includes(e)) out.push({ kind: "entity", token: e });
  }
  return out;
}

export function isGrounded(candidate: string, grounding: readonly string[], knownEntities: readonly string[] = []): boolean {
  return ungroundedClaims(candidate, grounding, knownEntities).length === 0;
}
