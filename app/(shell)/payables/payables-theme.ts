import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

/**
 * The single injection point for this feature's colour.
 *
 * House rule: the stylesheet is 100% `var()`, and exactly one module maps those
 * vars onto named design tokens. Nothing here is a literal colour, and nothing
 * in the stylesheet knows what a colour is — so re-theming the platform never
 * has to touch a feature's CSS.
 *
 * `dsv1.card` and its siblings carry a background-IMAGE stack (the Mist
 * treatment), so they are only ever valid in the `background` shorthand. The
 * stylesheet uses `background:` for every one of them, never `background-color`.
 */
export const PAYABLES_THEME = {
  "--pay-ink": TOKEN.dsv1.ink,
  "--pay-muted": TOKEN.dsv1.muted,
  "--pay-tertiary": TOKEN.dsv1.tertiary,
  "--pay-card": TOKEN.dsv1.card,
  "--pay-surface2": TOKEN.dsv1.surface2,
  "--pay-line": TOKEN.dsv1.line,
  "--pay-line-subtle": TOKEN.dsv1.lineSubtle,
  "--pay-accent": TOKEN.dsv1.accent,
  "--pay-accent-border": TOKEN.dsv1.accentSoftBorder,
  "--pay-action": TOKEN.dsv1.actionPrimary,
  "--pay-on-action": TOKEN.dsv1.actionPrimaryText,
  // No `?? fallback` anywhere in this map, deliberately. A missing token must
  // fail the typecheck, not quietly resolve to nothing — that is how the export
  // button once shipped painted in a colour defined nowhere, at 1.03:1.
  "--pay-shadow": TOKEN.dsv1.shadowCard,
  "--pay-success": TOKEN.dsv1.success,
  "--pay-success-bg": TOKEN.dsv1.successBg,
  "--pay-success-border": TOKEN.dsv1.successBorder,
  "--pay-warning-ink": TOKEN.dsv1.warningInk,
  "--pay-warning-bg": TOKEN.dsv1.warningBg,
  "--pay-warning-border": TOKEN.dsv1.warningBorder,
  "--pay-error": TOKEN.dsv1.error,
  "--pay-error-bg": TOKEN.dsv1.errorBg,
  "--pay-error-border": TOKEN.dsv1.errorBorder,
  "--pay-info-ink": TOKEN.dsv1.infoInk,
  "--pay-info-bg": TOKEN.dsv1.infoBg,
  "--pay-info-border": TOKEN.dsv1.infoBorder,
} as CSSProperties;
