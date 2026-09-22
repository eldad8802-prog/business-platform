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
   * ── Homepage v3 palette (D-derived art direction, owner-approved 2026-09-22) ──
   * Consumed only by the homepage (/home-candidate); declaring them here changes
   * nothing on /about, /contact or the legal pages.
   *
   * The page is PAPER with a small, compositional colour family — never one
   * colour per feature. Each hue repeats in different roles and scales:
   *   teal    — the anchor: the one deep band (leads)
   *   sage    — calm fields that belong to the Mist UI (collection, the map)
   *   ochre   — emphasis: the "מסודר." label, offset layers, the invoice
   *             field, the closing band
   *   sky     — cool masses behind product objects (hero, documents, today)
   *   coral   — a single accent label (leads). Never a field.
   * Ink and action stay the Mist tokens, so product screenshots and marketing
   * share one text colour and one action colour.
   */
  "--mkt3-paper": "#f6f3ec",
  "--mkt3-white": "#fffdf8",
  "--mkt3-ink": "var(--dz-text-primary)",
  "--mkt3-ink2": "var(--dz-text-secondary)",
  "--mkt3-action": "var(--dz-action-primary)",
  "--mkt3-teal": "#1f4a46",
  "--mkt3-teal-ink": "#0f2d2a",
  "--mkt3-on-teal": "#fbfaf6",
  "--mkt3-on-teal2": "#c9d4cf",
  "--mkt3-sage": "#d3e6dc",
  "--mkt3-sage2": "#b8d6c7",
  "--mkt3-ochre": "#f1cc76",
  "--mkt3-ochre-soft": "#fbf3df",
  "--mkt3-on-ochre2": "#4d4431",
  "--mkt3-sky": "#c7dbec",
  "--mkt3-sky-soft": "#dfeaf4",
  "--mkt3-coral": "#eba58f",
  "--mkt3-sand": "#eadcc3",
} as CSSProperties;
