/**
 * Setup after signup — the pure model.
 *
 * One short, skippable screen: the owner tells Dubiz about the business in
 * their own words, and who their customers usually are. Nothing here picks a
 * category, a goal or a first action; the Home is the ordinary Home from the
 * first moment and fills in from real use.
 *
 * Both answers are OWNER_INPUT identity statements (the canonical home of
 * owner-declared identity — BusinessIdentityStatement), never a parallel store:
 *   description → DESCRIPTION (free text, ≤ 500, private unless approved later)
 *   audience    → TARGET_AUDIENCE INDIVIDUALS and/or BUSINESSES
 */

export const SETUP_AUDIENCES = ["INDIVIDUALS", "BUSINESSES", "BOTH"] as const;
export type SetupAudience = (typeof SETUP_AUDIENCES)[number];

/** The two audience codes this screen owns. Other TARGET_AUDIENCE codes are never touched here. */
export const SETUP_AUDIENCE_CODES = ["INDIVIDUALS", "BUSINESSES"] as const;
export type SetupAudienceCode = (typeof SETUP_AUDIENCE_CODES)[number];

export const DESCRIPTION_MAX = 500;

export type SetupView = {
  /** True until the owner finished or skipped the screen once. */
  needsSetup: boolean;
  /** The owner's ACTIVE description, or null. */
  description: string | null;
  /** Derived from the ACTIVE INDIVIDUALS / BUSINESSES statements. */
  audience: SetupAudience | null;
};

export function isSetupAudience(v: unknown): v is SetupAudience {
  return typeof v === "string" && (SETUP_AUDIENCES as readonly string[]).includes(v);
}

export function audienceFromCodes(codes: readonly string[]): SetupAudience | null {
  const individuals = codes.includes("INDIVIDUALS");
  const businesses = codes.includes("BUSINESSES");
  if (individuals && businesses) return "BOTH";
  if (individuals) return "INDIVIDUALS";
  if (businesses) return "BUSINESSES";
  return null;
}

export function codesForAudience(a: SetupAudience): SetupAudienceCode[] {
  if (a === "BOTH") return ["INDIVIDUALS", "BUSINESSES"];
  return [a];
}

export type AboutAnswer = {
  /** undefined = leave as is; a non-empty string = the new description. */
  description?: string;
  /** undefined = leave as is. */
  audience?: SetupAudience;
};

/**
 * Validate one save. Either field may be absent (the screen saves as the owner
 * goes); an empty description is "not answered", never "erase what I said".
 */
export function validateAbout(input: { description?: unknown; audience?: unknown }): AboutAnswer | { error: string } {
  const out: AboutAnswer = {};
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") return { error: "invalid_description" };
    const text = input.description.replace(/\s+/g, " ").trim();
    if (text.length > DESCRIPTION_MAX) return { error: "description_too_long" };
    if (text.length > 0) out.description = text;
  }
  if (input.audience !== undefined && input.audience !== null) {
    if (!isSetupAudience(input.audience)) return { error: "invalid_audience" };
    out.audience = input.audience;
  }
  return out;
}

export function buildSetupView(f: {
  onboardingCompletedAt: Date | null;
  description: string | null;
  audienceCodes: readonly string[];
}): SetupView {
  return {
    needsSetup: f.onboardingCompletedAt === null,
    description: f.description && f.description.trim() ? f.description : null,
    audience: audienceFromCodes(f.audienceCodes),
  };
}
