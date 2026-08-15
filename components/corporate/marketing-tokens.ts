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
  "--mkt-cta": TOKEN.dsv1.gradient,
  "--mkt-cta-hover": TOKEN.dsv1.gradientHover,
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
} as CSSProperties;
