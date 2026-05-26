import type { QuestionFamilyId } from "./types";
import { DEFAULT_VIDEO_FAMILY_ORDER } from "./archetype-preferences";

/**
 * Picks the first family in `preferredOrder` that is not blocked.
 * Blocks: `lastQuestionFamily` (no immediate repeat), plus `excludeFamilies`.
 * If everything in the preferred list is blocked, walks `DEFAULT_VIDEO_FAMILY_ORDER`
 * (still respecting immediate-repeat ban when possible).
 */
export function pickNextQuestionFamily(params: {
  preferredOrder: QuestionFamilyId[];
  lastQuestionFamily?: QuestionFamilyId | null;
  excludeFamilies?: QuestionFamilyId[];
}): QuestionFamilyId {
  const blocked = new Set(params.excludeFamilies ?? []);
  const last = params.lastQuestionFamily ?? null;
  if (last) blocked.add(last);

  for (const f of params.preferredOrder) {
    if (!blocked.has(f)) return f;
  }

  for (const f of DEFAULT_VIDEO_FAMILY_ORDER) {
    if (!blocked.has(f)) return f;
  }

  /** Only one family exists in bank — cannot satisfy; return first preferred */
  if (params.preferredOrder[0]) return params.preferredOrder[0];
  return DEFAULT_VIDEO_FAMILY_ORDER[0];
}

/** Stable integer in [0, modulo) from seed (deterministic). */
export function stablePickIndex(seed: number, modulo: number): number {
  if (modulo <= 0) return 0;
  const x = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : 0;
  return x % modulo;
}

export function defaultSelectionSeed(input: {
  contentArchetypeId?: string;
  lastQuestionFamily?: QuestionFamilyId | null;
  goal?: string;
  contentAngle?: string;
}): number {
  const parts = [
    input.contentArchetypeId ?? "",
    input.lastQuestionFamily ?? "",
    input.goal ?? "",
    input.contentAngle ?? "",
  ];
  let h = 0;
  for (const s of parts) {
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return h;
}
