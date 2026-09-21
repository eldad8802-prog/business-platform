/**
 * Marketing (Corporate) design tokens.
 *
 * Single source of truth is `lib/design/tokens.ts` (TOKEN). This layer does NOT
 * define any new colors — it only re-maps platform tokens to marketing-scoped CSS
 * custom properties so the public site and the app share one brand.
 *
 * Brand alignment (Warm Alignment): the corporate layer now maps to the canonical
 * **Design System v1 warm** identity (`TOKEN.dsv1` — cream canvas, teal accent,
 * warm neutrals), matching `.dz-btn-primary` (which already uses the DS v1 teal).
 * This removes the previous split-brand where the CTA was warm but the body tokens
 * still pointed at the legacy cool navy set. Token remap only — no redesign, no new
 * colors, no per-page changes.
 *
 * Usage: spread `marketingVars` onto the Corporate layout wrapper. Components
 * then reference the brand through Tailwind arbitrary values, e.g.
 *   text-[var(--mkt-link)]   bg-[var(--mkt-soft)]   border-[var(--mkt-soft-border)]
 *
 * Note: marketing neutrals (gray-400/500/600) are intentionally left as Tailwind
 * utilities — they already read as calm warm-neutral text on the cream canvas and
 * carry AA contrast, so they stay without indirection.
 *
 * The Primary CTA is owned solely by `.dz-btn-primary` (app/globals.css, DS v1
 * teal). The `--mkt-cta*` vars below have no consumers today (kept, warm-aligned,
 * for parity); do not build a second primary-button authority from them.
 */
import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

export const marketingVars = {
  /** Primary CTA background — DS v1 warm teal gradient (parity with .dz-btn-primary; currently unconsumed). */
  "--mkt-cta": TOKEN.dsv1.actionPrimary,
  "--mkt-cta-hover": TOKEN.dsv1.actionPrimaryHover,
  /** CTA surface treatment — warm teal glow + hairline (parity; currently unconsumed). */
  "--mkt-cta-border": `1px solid ${TOKEN.dsv1.onAccent}`,
  "--mkt-cta-shadow": TOKEN.dsv1.shadowGlow,
  /** Deep brand accent — DS v1 teal for solid emphasis where a gradient is not wanted. */
  "--mkt-navy": TOKEN.dsv1.accent,
  /** Interactive text: links + active nav — DS v1 teal accent (AA on cream / white). */
  "--mkt-link": TOKEN.dsv1.accent,
  /** Primary heading / ink text — DS v1 warm ink. */
  "--mkt-ink": TOKEN.dsv1.ink,
  /** Soft brand fill for pills, badges, active states, icon tiles — DS v1 warm soft surface. */
  "--mkt-soft": TOKEN.dsv1.surface2,
  /** Border for soft brand surfaces — DS v1 warm line. */
  "--mkt-soft-border": TOKEN.dsv1.line,
  /** Canonical neutral border (cards, header/footer dividers) — DS v1 warm line. */
  "--mkt-border": TOKEN.dsv1.line,
  /** Page canvas — DS v1 warm cream. */
  "--mkt-page": TOKEN.dsv1.canvas,

  /*
   * ── Homepage rhythm (Sage & Sand) and the product stage (Forest) ──────────
   * Consumed only by the homepage candidate; declaring them here changes
   * nothing on /about, /contact or the legal pages. Every value is DERIVED from
   * Dubiz Mist — no new hue enters the system:
   *
   *   cream pigment  the opaque colour behind `--dz-mist-cream*`
   *                  (rgba(206,178,134,·) in dubiz-mist.css). color-mix in srgb
   *                  of two opaque colours equals alpha-compositing, so
   *   sand           = that pigment at 15% over the Mist ground → ≈ #eeebe0,
   *                  the same strength as `--dz-mist-cream-strong`.
   *   stage          = `--dz-app-chrome` (#23302b), Mist's own deep forest ink.
   *
   * Measured: ink on sand 11.5:1, secondary 5.4:1 (AA). `--dz-text-muted` on
   * sand is 4.37:1 — so sand is only for sections that do not set muted text.
   * On the stage: paper 13.1:1, muted-on-stage 7.2:1, the cream marker 6.8:1
   * (≥ 3:1 non-text, WCAG 1.4.11).
   */
  "--mkt-cream-pigment": "rgb(206 178 134)",
  "--mkt-sand": "color-mix(in srgb, var(--mkt-cream-pigment) 15%, var(--dz-background))",
  "--mkt-stage": "var(--dz-app-chrome)",
  "--mkt-on-stage": "var(--dz-text-on-brand)",
  "--mkt-on-stage-muted": "color-mix(in srgb, var(--dz-text-on-brand) 70%, var(--dz-app-chrome))",
  /** Hairlines and the resting segmented track on the stage. */
  "--mkt-stage-line": "color-mix(in srgb, var(--dz-text-on-brand) 16%, var(--dz-app-chrome))",
  "--mkt-stage-track": "color-mix(in srgb, var(--dz-text-on-brand) 8%, var(--dz-app-chrome))",
  /** The selection marker on the stage — warm, never the action teal. */
  "--mkt-stage-marker": "var(--mkt-cream-pigment)",

  /** Two radius levels for marketing surfaces: an object, and a control on it. */
  "--mkt-radius-object": "20px",
  "--mkt-radius-control": "12px",
} as CSSProperties;
