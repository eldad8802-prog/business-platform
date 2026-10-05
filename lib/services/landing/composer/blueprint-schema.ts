import type { SectionCode } from "../landing-strategy-vocabulary";

/**
 * P3-C · The composer DRAFT — the closed structure the model fills in. It contains copy and refs only:
 * no authority field (public / verified / available), no URLs, no HTML / Markdown / JSX / CSS, no
 * strategy identity. Sections are a discriminated union over the P3-B section vocabulary (HERO is
 * the separate `hero` object). The final LandingBlueprint is assembled from a validated draft by
 * deterministic code (blueprint-assembly.ts).
 */

export const BLUEPRINT_VERSION = "p3c.blueprint.v1";

export type DraftOfferingItem = { offeringRef: string; blurb: string };
export type DraftSection =
  | { sectionType: "PRIMARY_ACTION" | "CONTACT_PANEL"; heading: string; body: string }
  | { sectionType: "ABOUT"; heading: string; body: string; statementRefs: string[] }
  | { sectionType: "SERVICES_OVERVIEW" | "PRODUCTS_SHOWCASE" | "FEATURED_OFFERINGS"; heading: string; intro: string; items: DraftOfferingItem[] }
  | { sectionType: "TRUST_PROOF"; heading: string; intro: string; trustClaimRefs: string[] }
  | { sectionType: "QUOTE_PROCESS" | "BOOKING_INFO"; heading: string; steps: string[] }
  | { sectionType: "LOCATION_AND_HOURS"; heading: string; factRefs: string[] }
  | { sectionType: "SERVICE_AREA"; heading: string; statementRefs: string[] };

export type ComposerDraft = {
  pageIntent: string;
  hero: { headline: string; subheadline: string; assetRef: string | null };
  sections: DraftSection[];
  /** Label only. Null when the strategy has no action (SURFACE_ONLY) — any label there is a violation. */
  primaryActionLabel: string | null;
  secondaryActionLabel: string | null;
  metaTitle: string;
  metaDescription: string;
};

export const COMPOSABLE_SECTIONS: readonly Exclude<SectionCode, "HERO">[] = [
  "PRIMARY_ACTION", "CONTACT_PANEL", "ABOUT", "SERVICES_OVERVIEW", "PRODUCTS_SHOWCASE", "FEATURED_OFFERINGS",
  "TRUST_PROOF", "QUOTE_PROCESS", "BOOKING_INFO", "LOCATION_AND_HOURS", "SERVICE_AREA",
];

/** Field length limits (characters). Exceeding one is a structural, repairable error. */
export const LIMITS = { pageIntent: 160, headline: 90, subheadline: 220, heading: 80, body: 600, intro: 300, blurb: 200, step: 140, label: 40, metaTitle: 70, metaDescription: 170, maxItems: 8, maxSteps: 4, maxSections: 12 } as const;

/* ─── strict JSON Schema (structured output) ─────────────────────────────────────────────────── */

const str = (maxLength: number) => ({ type: "string", maxLength });
const nullableStr = (maxLength: number) => ({ type: ["string", "null"], maxLength });
const refs = { type: "array", items: { type: "string" }, maxItems: LIMITS.maxItems };
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const sectionSchema = (types: string[], properties: Record<string, unknown>) => obj({ sectionType: { type: "string", enum: types }, ...properties });

export const COMPOSER_DRAFT_JSON_SCHEMA = obj({
  pageIntent: str(LIMITS.pageIntent),
  hero: obj({ headline: str(LIMITS.headline), subheadline: str(LIMITS.subheadline), assetRef: nullableStr(40) }),
  sections: {
    type: "array",
    maxItems: LIMITS.maxSections,
    items: {
      anyOf: [
        sectionSchema(["PRIMARY_ACTION", "CONTACT_PANEL"], { heading: str(LIMITS.heading), body: str(LIMITS.body) }),
        sectionSchema(["ABOUT"], { heading: str(LIMITS.heading), body: str(LIMITS.body), statementRefs: refs }),
        sectionSchema(["SERVICES_OVERVIEW", "PRODUCTS_SHOWCASE", "FEATURED_OFFERINGS"], {
          heading: str(LIMITS.heading), intro: str(LIMITS.intro),
          items: { type: "array", maxItems: LIMITS.maxItems, items: obj({ offeringRef: str(40), blurb: str(LIMITS.blurb) }) },
        }),
        sectionSchema(["TRUST_PROOF"], { heading: str(LIMITS.heading), intro: str(LIMITS.intro), trustClaimRefs: refs }),
        sectionSchema(["QUOTE_PROCESS", "BOOKING_INFO"], { heading: str(LIMITS.heading), steps: { type: "array", maxItems: LIMITS.maxSteps, items: str(LIMITS.step) } }),
        sectionSchema(["LOCATION_AND_HOURS"], { heading: str(LIMITS.heading), factRefs: refs }),
        sectionSchema(["SERVICE_AREA"], { heading: str(LIMITS.heading), statementRefs: refs }),
      ],
    },
  },
  primaryActionLabel: nullableStr(LIMITS.label),
  secondaryActionLabel: nullableStr(LIMITS.label),
  metaTitle: str(LIMITS.metaTitle),
  metaDescription: str(LIMITS.metaDescription),
});

/* ─── strict runtime parser (never trusts the provider's schema enforcement alone) ───────────── */

export type StructuralError = { path: string; problem: string };

const SECTION_KEYS: Record<string, string[]> = {
  PRIMARY_ACTION: ["heading", "body"],
  CONTACT_PANEL: ["heading", "body"],
  ABOUT: ["heading", "body", "statementRefs"],
  SERVICES_OVERVIEW: ["heading", "intro", "items"],
  PRODUCTS_SHOWCASE: ["heading", "intro", "items"],
  FEATURED_OFFERINGS: ["heading", "intro", "items"],
  TRUST_PROOF: ["heading", "intro", "trustClaimRefs"],
  QUOTE_PROCESS: ["heading", "steps"],
  BOOKING_INFO: ["heading", "steps"],
  LOCATION_AND_HOURS: ["heading", "factRefs"],
  SERVICE_AREA: ["heading", "statementRefs"],
};
const STRING_LIMIT: Record<string, number> = { heading: LIMITS.heading, body: LIMITS.body, intro: LIMITS.intro };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function exactKeys(v: Record<string, unknown>, keys: string[], path: string, errors: StructuralError[]) {
  for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push({ path: `${path}.${k}`, problem: "UNEXPECTED_FIELD" });
  for (const k of keys) if (!(k in v)) errors.push({ path: `${path}.${k}`, problem: "MISSING_FIELD" });
}
function checkString(v: unknown, max: number, path: string, errors: StructuralError[], nullable = false) {
  if (v === null && nullable) return;
  if (typeof v !== "string") errors.push({ path, problem: nullable ? "NOT_STRING_OR_NULL" : "NOT_STRING" });
  else if (!v.trim()) errors.push({ path, problem: "EMPTY" });
  else if (v.length > max) errors.push({ path, problem: `TOO_LONG_MAX_${max}` });
}
function checkStringArray(v: unknown, maxItems: number, maxLen: number, path: string, errors: StructuralError[]) {
  if (!Array.isArray(v)) return errors.push({ path, problem: "NOT_ARRAY" });
  if (v.length > maxItems) errors.push({ path, problem: `TOO_MANY_MAX_${maxItems}` });
  v.forEach((x, i) => checkString(x, maxLen, `${path}[${i}]`, errors));
}

/** Parse raw model text into a ComposerDraft. Structural problems only; meaning is checked by the validator. */
export function parseComposerDraft(raw: string): { draft: ComposerDraft | null; errors: StructuralError[] } {
  const errors: StructuralError[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { draft: null, errors: [{ path: "$", problem: "NOT_JSON" }] };
  }
  if (!isObj(value)) return { draft: null, errors: [{ path: "$", problem: "NOT_OBJECT" }] };
  exactKeys(value, ["pageIntent", "hero", "sections", "primaryActionLabel", "secondaryActionLabel", "metaTitle", "metaDescription"], "$", errors);
  checkString(value.pageIntent, LIMITS.pageIntent, "$.pageIntent", errors);
  checkString(value.metaTitle, LIMITS.metaTitle, "$.metaTitle", errors);
  checkString(value.metaDescription, LIMITS.metaDescription, "$.metaDescription", errors);
  checkString(value.primaryActionLabel, LIMITS.label, "$.primaryActionLabel", errors, true);
  checkString(value.secondaryActionLabel, LIMITS.label, "$.secondaryActionLabel", errors, true);
  if (!isObj(value.hero)) errors.push({ path: "$.hero", problem: "NOT_OBJECT" });
  else {
    exactKeys(value.hero, ["headline", "subheadline", "assetRef"], "$.hero", errors);
    checkString(value.hero.headline, LIMITS.headline, "$.hero.headline", errors);
    checkString(value.hero.subheadline, LIMITS.subheadline, "$.hero.subheadline", errors);
    checkString(value.hero.assetRef, 40, "$.hero.assetRef", errors, true);
  }
  if (!Array.isArray(value.sections)) errors.push({ path: "$.sections", problem: "NOT_ARRAY" });
  else {
    if (value.sections.length > LIMITS.maxSections) errors.push({ path: "$.sections", problem: `TOO_MANY_MAX_${LIMITS.maxSections}` });
    value.sections.forEach((s, i) => {
      const path = `$.sections[${i}]`;
      if (!isObj(s)) return errors.push({ path, problem: "NOT_OBJECT" });
      const type = s.sectionType;
      // An unknown section type is NOT structural: it is an attempt to add a capability. The validator
      // reports it as SECTION_NOT_ALLOWED (non-repairable); here it is only recorded and kept.
      if (typeof type !== "string") return errors.push({ path: `${path}.sectionType`, problem: "NOT_STRING" });
      const keys = SECTION_KEYS[type];
      if (!keys) return;
      exactKeys(s, ["sectionType", ...keys], path, errors);
      for (const k of keys) {
        if (k in STRING_LIMIT) checkString(s[k], STRING_LIMIT[k], `${path}.${k}`, errors);
        else if (k === "steps") checkStringArray(s[k], LIMITS.maxSteps, LIMITS.step, `${path}.steps`, errors);
        else if (k === "items") {
          if (!Array.isArray(s.items)) errors.push({ path: `${path}.items`, problem: "NOT_ARRAY" });
          else {
            if (s.items.length > LIMITS.maxItems) errors.push({ path: `${path}.items`, problem: `TOO_MANY_MAX_${LIMITS.maxItems}` });
            s.items.forEach((it, j) => {
              if (!isObj(it)) return errors.push({ path: `${path}.items[${j}]`, problem: "NOT_OBJECT" });
              exactKeys(it, ["offeringRef", "blurb"], `${path}.items[${j}]`, errors);
              checkString(it.offeringRef, 40, `${path}.items[${j}].offeringRef`, errors);
              checkString(it.blurb, LIMITS.blurb, `${path}.items[${j}].blurb`, errors);
            });
          }
        } else checkStringArray(s[k], LIMITS.maxItems, 40, `${path}.${k}`, errors);
      }
    });
  }
  return { draft: errors.length ? null : (value as unknown as ComposerDraft), errors };
}

/** The draft as raw JSON even when structurally broken — the validator still scans unknown sections. */
export function looseSectionTypes(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as { sections?: { sectionType?: unknown }[] };
    return Array.isArray(v.sections) ? v.sections.map((s) => String(s?.sectionType ?? "")) : [];
  } catch {
    return [];
  }
}
