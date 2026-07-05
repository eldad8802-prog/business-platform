/**
 * Documents — Dubiz Design System v1 theme (warm cream / teal).
 *
 * PRESENTATION ONLY. The Documents feature was authored on the cool navy/slate
 * `TOKEN` set; the live product reference (Payment Secretary + Collection) is
 * the warm DS v1 language (`TOKEN.dsv1`). This module re-skins Documents onto
 * DS v1 from ONE place: it re-exports a `TOKEN`-shaped object whose surfaces,
 * ink, borders, brand, semantic signals, radii, weights and shadows are mapped
 * to the DS v1 source-of-truth, plus warm variants of the shared action styles.
 *
 * Every Documents file swaps its imports from `@/lib/design/tokens` /
 * `@/lib/design/action-styles` to this module — no call sites change, so the
 * palette flips centrally exactly like the Secretary's `secretaryVars()`.
 *
 * Values come straight from `TOKEN.dsv1` — never invented or altered. Weight
 * `bold` folds to 600 (DS v1 forbids 700); radii fold to the warm scale
 * (field 12 · button 14 · card 16 · dialog 20). Non-visual scales that DS v1
 * shares (space, font sizes, transitions) pass through from the base set.
 */

import type { CSSProperties } from "react";
import { TOKEN as BASE } from "./tokens";

const d = BASE.dsv1;

export const TOKEN = {
  ...BASE,

  surface: {
    // Near-black chrome stays as-is (rail/app-level, outside the Documents skin).
    appChrome: BASE.surface.appChrome,
    /** Page canvas — warm cream. */
    page: d.canvas,
    /** Cards, panels, banners — warm paper. */
    card: d.card,
    /** Inset surface inside cards (inputs, tiles, draft containers). */
    inset: d.surface2,
    /** Floating overlays (drawer/sheet/dropdown) — warm paper. */
    overlay: d.card,
  },

  brand: {
    ...BASE.brand,
    navy: d.accent,
    denim: d.info,
    light: d.info,
    /** Interactive links / active text / icon accents — teal accent. */
    mid: d.accent,
    gradient: d.gradient,
    gradientHover: d.gradientHover,
    /** Soft tinted fill for active/selected surfaces (teal tint). */
    soft: d.successBg,
    softBorder: d.accent,
    focus: d.ring,
  },

  action: {
    primary: {
      background: d.gradient,
      backgroundHover: d.gradientHover,
      color: d.onAccent,
      border: "0",
      shadow: d.shadowGlow,
      shadowSoft: d.shadowGlow,
    },
    glass: {
      background: d.card,
      backgroundHover: d.surface2,
      color: d.ink,
      border: `1px solid ${d.line}`,
      shadow: "0 1px 2px rgba(88, 62, 38, 0.05)",
    },
    danger: {
      background: d.card,
      color: d.error,
      border: `1px solid ${d.line}`,
      shadow: "0 1px 2px rgba(88, 62, 38, 0.05)",
    },
  },

  ink: {
    primary: d.ink,
    secondary: d.muted,
    muted: d.muted,
    meta: d.tertiary,
    disabled: d.tertiary,
    inverse: d.onAccent,
  },

  border: {
    /** Single canonical hairline. */
    DEFAULT: d.line,
    /** Hover — the warm muted-2 tone. */
    hover: d.tertiary,
    /** Selection / active emphasis — teal (never black in DS v1). */
    strong: d.accent,
    transparent: "transparent",
  },

  /**
   * Warm status signals — color-as-signal, never a block. Mapped to DS v1:
   * urgent → clay (late/error) · attention → brown (partial) · success → teal
   * (verified) · info → light-teal (never blue).
   */
  semantic: {
    urgent: {
      ink: d.error,
      bg: d.errorBg,
      bgSoft: d.errorBg,
      border: "rgba(184, 92, 63, 0.30)",
      accent: d.error,
    },
    attention: {
      ink: d.warningInk,
      bg: d.warningBg,
      bgSoft: d.warningBg,
      border: "rgba(184, 135, 85, 0.32)",
      accent: d.warning,
    },
    success: {
      ink: d.success,
      bg: d.successBg,
      bgSoft: d.successBg,
      border: "rgba(36, 105, 102, 0.26)",
      accent: d.success,
    },
    info: {
      ink: d.infoInk,
      bg: d.infoBg,
      bgSoft: d.infoBg,
      border: "rgba(61, 156, 154, 0.30)",
      accent: d.info,
    },
  },

  /** Warm radius scale (DS v1). */
  radius: {
    chip: d.radius.field,
    button: d.radius.button,
    input: d.radius.field,
    card: d.radius.card,
    modal: d.radius.dialog,
    pill: d.radius.pill,
  },

  /** DS v1 forbids weight 700 — `bold` folds to semibold (600). */
  weight: {
    regular: d.weight.regular,
    medium: d.weight.medium,
    semibold: d.weight.semibold,
    bold: d.weight.semibold,
  },

  shadow: {
    none: "none",
    /** Resting cards — warm paper shadow (works with a 1px hairline). */
    elevated: d.shadowCard,
    /** Floating overlays — drawer, sheet, dropdown. */
    floating: d.shadowOverlay,
    /** Edge shadow. */
    nav: d.shadowCard,
  },
};

// --- Warm action styles (mirror lib/design/action-styles.ts, warm TOKEN) ---

type ActionOptions = {
  disabled?: boolean;
  fullWidth?: boolean;
  height?: number;
};

const disabledPrimaryBg = d.surface2;

export function primaryActionStyle({
  disabled,
  fullWidth,
  height = 52,
}: ActionOptions = {}): CSSProperties {
  return {
    width: fullWidth ? "100%" : undefined,
    minHeight: height,
    padding: "10px 18px",
    borderRadius: TOKEN.radius.button,
    border: 0,
    background: disabled ? disabledPrimaryBg : TOKEN.action.primary.background,
    color: disabled ? TOKEN.ink.meta : TOKEN.action.primary.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? TOKEN.shadow.none : TOKEN.action.primary.shadow,
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
    borderRadius: TOKEN.radius.button,
    border: TOKEN.action.glass.border,
    background: TOKEN.action.glass.background,
    color: TOKEN.action.glass.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: TOKEN.action.glass.shadow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
    lineHeight: 1.15,
    textDecoration: "none",
  };
}

export function iconActionStyle(accent = false, disabled = false): CSSProperties {
  return {
    width: 42,
    height: 42,
    borderRadius: TOKEN.radius.pill,
    padding: 0,
    ...(accent
      ? primaryActionStyle({ disabled, height: 42 })
      : glassActionStyle({ disabled, height: 42 })),
    flexShrink: 0,
  };
}

export function chipActionStyle(active = false): CSSProperties {
  return {
    minHeight: 40,
    padding: "7px 16px",
    borderRadius: TOKEN.radius.chip,
    border: active ? `1px solid ${d.accent}` : TOKEN.action.glass.border,
    background: active ? d.successBg : TOKEN.action.glass.background,
    color: active ? d.accent : TOKEN.action.glass.color,
    boxShadow: active ? TOKEN.shadow.none : TOKEN.action.glass.shadow,
    fontFamily: "inherit",
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.semibold,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.xs,
    whiteSpace: "nowrap",
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
    borderRadius: TOKEN.radius.button,
    border: TOKEN.action.danger.border,
    background: TOKEN.action.danger.background,
    color: TOKEN.action.danger.color,
    fontFamily: "inherit",
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.semibold,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: TOKEN.action.danger.shadow,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: TOKEN.space.sm,
  };
}
