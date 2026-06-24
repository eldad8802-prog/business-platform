/**
 * Marketing (Corporate) design tokens.
 *
 * Single source of truth is `lib/design/tokens.ts` (TOKEN). This layer does NOT
 * define any new colors — it only re-maps the platform brand tokens to
 * marketing-scoped CSS custom properties, so the public site and the app share
 * one brand (the Dubiz navy→denim gradient + brand neutrals).
 *
 * Usage: spread `marketingVars` onto the Corporate layout wrapper. Components
 * then reference the brand through Tailwind arbitrary values, e.g.
 *   bg-[image:var(--mkt-cta)]   text-[var(--mkt-link)]
 *   bg-[var(--mkt-soft)]        border-[var(--mkt-soft-border)]
 *
 * Note: marketing neutrals (gray-400/500/600) are intentionally left as Tailwind
 * utilities — they already equal TOKEN.ink.meta/muted/secondary exactly, so they
 * are on-brand without indirection.
 */
import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

export const marketingVars = {
  /** Primary CTA + brand "D" — the official Dubiz navy→denim gradient. */
  "--mkt-cta": TOKEN.brand.gradient,
  "--mkt-cta-hover": TOKEN.brand.gradientHover,
  /**
   * CTA surface treatment — full parity with the app's primary action.
   * `border` is the hairline white edge; `shadow` carries the elevation AND the
   * `inset 0 1px 0` inner highlight that lifts white-text legibility on the
   * denim end of the gradient. Both values come straight from TOKEN.action.primary.
   */
  "--mkt-cta-border": TOKEN.action.primary.border,
  "--mkt-cta-shadow": TOKEN.action.primary.shadow,
  /** Deep brand navy — solid emphasis where a gradient is not wanted. */
  "--mkt-navy": TOKEN.brand.navy,
  /** Interactive text: links + active nav (AA on white). */
  "--mkt-link": TOKEN.brand.mid,
  /** Primary heading / ink text. */
  "--mkt-ink": TOKEN.ink.primary,
  /** Soft brand fill for pills, badges, active states, icon tiles. */
  "--mkt-soft": TOKEN.brand.soft,
  /** Border for soft brand surfaces. */
  "--mkt-soft-border": TOKEN.brand.softBorder,
  /** Canonical neutral border (cards, header/footer dividers). */
  "--mkt-border": TOKEN.border.DEFAULT,
  /** Page canvas. */
  "--mkt-page": TOKEN.surface.page,
} as CSSProperties;
