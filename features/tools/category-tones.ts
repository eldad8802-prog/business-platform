import type { ToolGroupKey } from "@/lib/navigation/home-routes";

/**
 * The three category tones — declared once, shared by the Home cards and the
 * three category screens, so the colour the owner tapped is the colour they
 * land on.
 *
 * MUTED on purpose: each hue is mixed toward grey (sage-teal, dusty wine,
 * steel slate) and the two gradient stops sit close together, so the surface
 * reads as a quiet tone with a little depth rather than as "a gradient". The
 * stops stay dark enough that near-white text clears WCAG AA against every
 * one of them; the QA pass measures that on the rendered page.
 *
 *   a / b   surface gradient stops
 *   ink     the glyph colour on the dark surface
 *   tint    a light ground for a glyph on a white surface
 *   deep    the glyph colour on that light ground
 */
export type CategoryTone = {
  a: string;
  b: string;
  ink: string;
  tint: string;
  deep: string;
};

export const CATEGORY_TONES: Record<ToolGroupKey, CategoryTone> = {
  money: { a: "#4A6B61", b: "#425F56", ink: "#DCE9E3", tint: "#E6EEEA", deep: "#3F5E55" },
  customers: { a: "#7A4F58", b: "#6C4550", ink: "#F0DDE1", tint: "#F2E8EA", deep: "#6C4550" },
  operations: { a: "#4D6177", b: "#435569", ink: "#DCE4EE", tint: "#E6EBF1", deep: "#435569" },
};

/** `.tone-money{--ct-a:…}` — one class per category, custom properties only. */
export function categoryToneCss(scope: string): string {
  return (Object.keys(CATEGORY_TONES) as ToolGroupKey[])
    .map((key) => {
      const t = CATEGORY_TONES[key];
      return `${scope} .tone-${key},${scope}.tone-${key}{--ct-a:${t.a};--ct-b:${t.b};--ct-ink:${t.ink};--ct-tint:${t.tint};--ct-deep:${t.deep}}`;
    })
    .join("\n");
}
