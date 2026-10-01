/**
 * P2 · Content Studio choice provenance — was a tone / audience CHOSEN by the owner, or filled in?
 *
 * The content flow persists `selectedDirection.tone` and `audienceTypes` into ContentRun.inputSnapshot.
 * Both can be produced by a default as easily as by the owner (`vibeToTone` falls back to "warm" when
 * no vibe was picked; `audienceTypes` is computed from the goal). Without a marker the two are
 * indistinguishable, and months of real owner preference would be unrecoverable.
 *
 * So every new run records, beside the values, how each one came to be:
 *   tone      OWNER_SELECTED  the owner clicked a vibe in this flow (or carried an owner-selected one forward)
 *             DEFAULTED       no vibe existed; the flow filled the tone in
 *             UNKNOWN         a vibe existed but its origin was not recorded (legacy flow state)
 *   audience  OWNER_SELECTED  the owner picked the audience explicitly (no such control exists today)
 *             DERIVED         computed from the goal (defaultAudienceTypes) — every audience today
 *             UNKNOWN         not recorded
 * Runs persisted before this marker have none and read as LEGACY_AMBIGUOUS: never owner evidence,
 * never backfilled.
 *
 * Pure and dependency-free: imported by the client flow and by the server persistence.
 */

export const TONE_PROVENANCE = ["OWNER_SELECTED", "DEFAULTED", "UNKNOWN"] as const;
export type ToneProvenance = (typeof TONE_PROVENANCE)[number];

export const AUDIENCE_PROVENANCE = ["OWNER_SELECTED", "DERIVED", "UNKNOWN"] as const;
export type AudienceProvenance = (typeof AUDIENCE_PROVENANCE)[number];

export type ChoiceProvenance = { tone: ToneProvenance; audience: AudienceProvenance };

/** How a persisted run reads when it carries no marker at all. */
export const LEGACY_AMBIGUOUS = "LEGACY_AMBIGUOUS" as const;

/** Client: the vibe's origin when the owner continues from the vibe step. */
export function vibeSourceOnContinue(clickedThisVisit: boolean, carried: unknown): ToneProvenance {
  if (clickedThisVisit) return "OWNER_SELECTED";
  // A vibe restored from saved flow state is only as explicit as the record that came with it.
  return carried === "OWNER_SELECTED" ? "OWNER_SELECTED" : "UNKNOWN";
}

/** Client: the tone's origin when the flow turns the vibe into `selectedDirection.tone`. */
export function toneProvenanceFor(vibe: string | null | undefined, vibeSource: unknown): ToneProvenance {
  if (!vibe) return "DEFAULTED";
  return vibeSource === "OWNER_SELECTED" ? "OWNER_SELECTED" : "UNKNOWN";
}

/**
 * Server: accept only known labels, and never let a label claim more than the values support — an
 * OWNER_SELECTED tone with no tone, or audience with no audience, is not evidence of anything.
 */
export function sanitizeChoiceProvenance(
  raw: unknown,
  values: { tone: unknown; audienceTypes: unknown },
): ChoiceProvenance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let tone: ToneProvenance = (TONE_PROVENANCE as readonly string[]).includes(r.tone as string) ? (r.tone as ToneProvenance) : "UNKNOWN";
  let audience: AudienceProvenance = (AUDIENCE_PROVENANCE as readonly string[]).includes(r.audience as string)
    ? (r.audience as AudienceProvenance)
    : "UNKNOWN";
  if (tone === "OWNER_SELECTED" && !(typeof values.tone === "string" && values.tone.trim())) tone = "UNKNOWN";
  if (audience === "OWNER_SELECTED" && !(Array.isArray(values.audienceTypes) && values.audienceTypes.length > 0)) audience = "UNKNOWN";
  return { tone, audience };
}

/** Reader: the provenance of a persisted run, with no marker meaning LEGACY_AMBIGUOUS. */
export function readChoiceProvenance(raw: unknown): { tone: ToneProvenance | typeof LEGACY_AMBIGUOUS; audience: AudienceProvenance | typeof LEGACY_AMBIGUOUS } {
  if (!raw || typeof raw !== "object") return { tone: LEGACY_AMBIGUOUS, audience: LEGACY_AMBIGUOUS };
  const r = raw as Record<string, unknown>;
  return {
    tone: (TONE_PROVENANCE as readonly string[]).includes(r.tone as string) ? (r.tone as ToneProvenance) : LEGACY_AMBIGUOUS,
    audience: (AUDIENCE_PROVENANCE as readonly string[]).includes(r.audience as string) ? (r.audience as AudienceProvenance) : LEGACY_AMBIGUOUS,
  };
}
