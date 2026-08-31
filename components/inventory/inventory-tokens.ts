/**
 * Design tokens — Inventory module.
 *
 * PRESENTATION ONLY. The Inventory feature was authored on the cool navy/slate
 * platform `TOKEN` set; the live product reference (Payment Secretary +
 * Collection + Documents) is the warm DS v1 language (`TOKEN.dsv1`). This module
 * re-skins Inventory onto DS v1 from ONE place: every surface, ink, border,
 * brand, semantic signal, radius and shadow is mapped to the DS v1
 * source-of-truth. Export names and shapes are preserved so no call site
 * changes — the palette flips centrally exactly like the Documents theme.
 *
 * Values come straight from `TOKEN.dsv1` — never invented or altered. DS v1
 * forbids weight 700+ and pure/cold colour. Radii fold to the warm scale
 * (field 12 · button 14 · card 16).
 */
import type { CSSProperties } from "react";
import { TOKEN } from "@/lib/design/tokens";

const d = TOKEN.dsv1;

export const inventoryTheme = {
  pageBg: d.canvas,
  cardBg: d.card,
  cardBorder: d.line,
  cardShadow: d.shadowCard,
  text: d.ink,
  textMuted: d.muted,
  /** Brand / link accent — DS v1 teal accent. */
  accent: d.accent,
  accentDark: d.accent,
  /** Primary CTA — DS v1 teal brand gradient. */
  primaryBtn: d.gradient,
  primaryBtnHover: d.gradientHover,
  primaryBorder: "0",
  primaryShadow: d.shadowGlow,
  primaryShadowSoft: d.shadowGlow,
  glassBg: d.card,
  glassBorder: `1px solid ${d.line}`,
  glassText: d.ink,
  glassShadow: d.shadowCard,
  successBtn: d.success,
  danger: d.error,
  warning: d.warning,
  info: d.info,
  /** DS v1 has no purple — neutral highlights fold to the teal accent. */
  purple: d.accent,
  /** Inset surface — inputs, segmented/stepper backgrounds. */
  surface: d.surface2,
  /** Focus ring color for inputs. */
  focus: d.ring,
} as const;

export const inventorySpacing = {
  xs: TOKEN.space.xs,
  sm: TOKEN.space.sm,
  md: TOKEN.space.md,
  lg: TOKEN.space.lg,
  xl: TOKEN.space.xl,
  xxl: TOKEN.space["2xl"],
  xxxl: TOKEN.space["3xl"],
} as const;

export const inventoryRadius = {
  sm: d.radius.field,
  md: d.radius.field,
  lg: d.radius.card,
  xl: d.radius.card,
  pill: d.radius.pill,
} as const;

export const inventoryLayout = {
  maxWidth: 960,
  maxWidthWide: 1080,
  bottomNavHeight: 64,
  safeBottomMobile: "calc(96px + env(safe-area-inset-bottom, 0px))",
} as const;

export type InventoryTone =
  | "danger"
  | "warning"
  | "purple"
  | "info"
  | "success"
  | "neutral";

/**
 * Warm status signals — colour-as-signal, never a block (DS v1). Mapped to the
 * DS v1 palette: danger → clay (late/error) · warning → brown (partial) ·
 * success → teal (verified) · info → light-teal (never blue) · purple folds to
 * the teal accent · neutral → warm surface-2.
 */
export const inventoryToneStyles: Record<
  InventoryTone,
  { bg: string; border: string; color: string; iconBg: string }
> = {
  danger: {
    bg: d.errorBg,
    border: d.errorBorder,
    color: d.error,
    iconBg: d.errorBg,
  },
  warning: {
    bg: d.warningBg,
    border: d.warningBorder,
    color: d.warningInk,
    iconBg: d.warningBg,
  },
  purple: {
    bg: d.successBg,
    border: d.successBorder,
    color: d.accent,
    iconBg: d.successBg,
  },
  info: {
    bg: d.infoBg,
    border: d.infoBorder,
    color: d.infoInk,
    iconBg: d.infoBg,
  },
  success: {
    bg: d.successBg,
    border: d.successBorder,
    color: d.success,
    iconBg: d.successBg,
  },
  neutral: {
    bg: d.surface2,
    border: d.line,
    color: d.muted,
    iconBg: d.surface2,
  },
};

/** CSS custom properties for foundation stylesheet */
export const inventoryCssVars = `
  --inv-page-bg: ${inventoryTheme.pageBg};
  --inv-card-bg: ${inventoryTheme.cardBg};
  --inv-surface-2: ${d.surface2};
  --inv-surface: ${inventoryTheme.surface};
  --inv-focus: ${inventoryTheme.focus};
  --inv-ring: ${d.ring};
  --inv-border: ${inventoryTheme.cardBorder};
  --inv-border-hover: ${d.tertiary};
  --inv-shadow: ${inventoryTheme.cardShadow};
  --inv-shadow-card-hover: ${d.shadowCardHover};
  --inv-shadow-glow: ${d.shadowGlow};
  --inv-shadow-overlay: ${d.shadowOverlay};
  --inv-backdrop: ${d.backdrop};
  --inv-text: ${inventoryTheme.text};
  --inv-text-muted: ${inventoryTheme.textMuted};
  --inv-text-tertiary: ${d.tertiary};
  --inv-accent: ${inventoryTheme.accent};
  --inv-accent-dark: ${inventoryTheme.accentDark};
  --inv-brand-denim: ${d.info};
  --inv-primary: ${inventoryTheme.primaryBtn};
  --inv-primary-hover: ${inventoryTheme.primaryBtnHover};
  --inv-primary-border: ${inventoryTheme.primaryBorder};
  --inv-primary-shadow: ${inventoryTheme.primaryShadow};
  --inv-primary-shadow-soft: ${inventoryTheme.primaryShadowSoft};
  --inv-on-accent: ${d.onAccent};
  --inv-glass-bg: ${inventoryTheme.glassBg};
  --inv-glass-border: ${inventoryTheme.glassBorder};
  --inv-glass-text: ${inventoryTheme.glassText};
  --inv-glass-shadow: ${inventoryTheme.glassShadow};
  --inv-danger: ${inventoryTheme.danger};
  --inv-danger-bg: ${d.errorBg};
  --inv-danger-border: ${d.errorBorder};
  --inv-warning: ${inventoryTheme.warning};
  --inv-warning-ink: ${d.warningInk};
  --inv-warning-bg: ${d.warningBg};
  --inv-warning-border: ${d.warningBorder};
  --inv-success: ${d.success};
  --inv-success-bg: ${d.successBg};
  --inv-success-border: ${d.successBorder};
  --inv-info: ${inventoryTheme.info};
  --inv-info-ink: ${d.infoInk};
  --inv-info-bg: ${d.infoBg};
  --inv-info-border: ${d.infoBorder};
  --inv-max-width: ${inventoryLayout.maxWidth}px;
  --inv-content-max: 720px;
  --inv-radius-lg: ${inventoryRadius.xl}px;
  --inv-radius-md: ${inventoryRadius.lg}px;
  --inv-radius-sm: ${inventoryRadius.sm}px;
  --inv-radius-button: ${d.radius.button}px;
  --inv-gap: ${inventorySpacing.xl}px;
  --inv-bottom-safe: ${inventoryLayout.safeBottomMobile};
`;

/* --- Inventory HOME accents (screen s8 modern redesign) --------------------
 * The home uses the same WARM DS v1 canvas as every other inventory sub-screen
 * (surfaces / text / status all resolve to the module's existing `--inv-*`
 * tokens — see `home-styles.ts`). What remains home-scoped here is only the
 * design layer that has no warm-module equivalent: the brand teal RAMP for the
 * hero (individual gradient stops, which the single `--inv-primary` gradient
 * token can't supply), the four categorical action-icon ACCENTS (teal / blue /
 * amber / violet), the warm skeleton shimmer pair, radii and easing.
 *
 * Literal values are declared here, in ONE place, and emitted only inside the
 * home's `[data-inventory-home]` block (`inventoryHomeCssVars`). They never leak
 * to other inventory screens and never touch the shared Documents anchor tokens
 * in `TOKEN.dsv1`. Every call site references `var(--inv-home-*)` — no hex in
 * components. */
export const inventoryHomePalette = {
  /** Brand teal ramp — hero gradient stops + teal controls. */
  teal1: "var(--dz-brand)",
  teal2: "var(--dz-brand)",
  teal3: "var(--dz-brand)",
  onTeal: d.onAccent,
  /** Categorical action-icon accents, tinted to read on the warm beige cards. */
  iconTeal: "var(--dz-brand)",
  iconTealBg: "rgba(36, 105, 102, 0.12)",
  iconBlue: "var(--dz-info)",
  iconBlueBg: "rgba(43, 90, 133, 0.13)",
  iconAmber: "var(--dz-warning)",
  iconAmberBg: "rgba(129, 90, 50, 0.16)",
  iconViolet: "var(--dz-brand)",
  iconVioletBg: "rgba(36, 105, 102, 0.15)",
  /** Warm skeleton shimmer (base → highlight), matching the cream module. */
  skBase: "var(--dz-surface-muted)",
  skHi: "var(--dz-surface-muted)",
  ease: "cubic-bezier(0.22, 0.61, 0.36, 1)",
} as const;

/** CSS custom properties for the home screen — emitted inside `[data-inventory-home]`. */
export const inventoryHomeCssVars = `
  --inv-home-teal-1: ${inventoryHomePalette.teal1};
  --inv-home-teal-2: ${inventoryHomePalette.teal2};
  --inv-home-teal-3: ${inventoryHomePalette.teal3};
  --inv-home-on-teal: ${inventoryHomePalette.onTeal};
  --inv-home-icon-teal: ${inventoryHomePalette.iconTeal};
  --inv-home-icon-teal-bg: ${inventoryHomePalette.iconTealBg};
  --inv-home-icon-blue: ${inventoryHomePalette.iconBlue};
  --inv-home-icon-blue-bg: ${inventoryHomePalette.iconBlueBg};
  --inv-home-icon-amber: ${inventoryHomePalette.iconAmber};
  --inv-home-icon-amber-bg: ${inventoryHomePalette.iconAmberBg};
  --inv-home-icon-violet: ${inventoryHomePalette.iconViolet};
  --inv-home-icon-violet-bg: ${inventoryHomePalette.iconVioletBg};
  --inv-home-sk-base: ${inventoryHomePalette.skBase};
  --inv-home-sk-hi: ${inventoryHomePalette.skHi};
  --inv-home-r-card: 20px;
  --inv-home-r-chip: 12px;
  --inv-home-ease: ${inventoryHomePalette.ease};
`;

/* --- Warm action styles (DS v1) ------------------------------------------
 * Inventory-scoped replacements for the cold `@/lib/design/action-styles`
 * helpers, mirroring the warm variants the Documents theme provides. Same
 * signatures, so importers only swap the module path. Values are DS v1: teal
 * gradient + glow for primary, warm paper + hairline for glass, clay for danger;
 * weight caps at 600. */
type ActionOptions = {
  disabled?: boolean;
  fullWidth?: boolean;
  height?: number;
};

export function primaryActionStyle({
  disabled,
  fullWidth,
  height = 52,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "10px 18px",
    borderRadius: d.radius.button,
    border: 0,
    background: disabled ? d.surface2 : d.gradient,
    color: disabled ? d.muted : d.onAccent,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: d.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? "none" : d.shadowGlow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
    lineHeight: 1.15,
    textDecoration: "none",
  };
}

export function glassActionStyle({
  disabled,
  fullWidth,
  height = 48,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "9px 16px",
    borderRadius: d.radius.button,
    border: `1px solid ${d.line}`,
    background: d.card,
    color: d.ink,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: d.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: d.shadowCard,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
    lineHeight: 1.15,
    textDecoration: "none",
  };
}

export function dangerActionStyle({
  disabled,
  fullWidth,
  height = 48,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "9px 16px",
    borderRadius: d.radius.button,
    border: `1px solid ${d.line}`,
    background: d.card,
    color: d.error,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: d.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: d.shadowCard,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
  };
}
