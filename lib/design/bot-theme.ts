/**
 * Bot Settings — Dubiz Design System v1 theme (warm cream / teal).
 *
 * PRESENTATION ONLY. The Bot Settings feature was authored on the cool navy/slate
 * `TOKEN` set; the live product reference (Payments, Secretary, Documents,
 * Inventory, Billing) is the warm DS v1 language (`TOKEN.dsv1`). This module
 * re-skins Bot Settings onto DS v1 from ONE place: it re-exports a `TOKEN`-shaped
 * object whose surfaces, ink, borders, brand, semantic signals, radii, weights
 * and shadows are mapped to the DS v1 source-of-truth.
 *
 * Every Bot Settings file swaps its import from `@/lib/design/tokens` to this
 * module — no call sites change, so the palette flips centrally exactly like the
 * Documents / Billing themes.
 *
 * Values come straight from `TOKEN.dsv1` — never invented or altered. Weight
 * `bold` folds to 600 (DS v1 forbids 700); radii fold to the warm scale
 * (field 12 · button 14 · card 16 · dialog 20). Non-visual scales that DS v1
 * shares (space, font sizes, transitions) pass through from the base set.
 *
 * NOT a source of truth for the WhatsApp chat preview: those bubble fills
 * (#e5ddd5 / #dcf8c6 / #ffffff) are literal WhatsApp brand colours representing
 * WhatsApp itself, kept off-token by design — this theme does not touch them.
 */

import { TOKEN as BASE } from "./tokens";

const d = BASE.dsv1;

export const TOKEN = {
  ...BASE,

  surface: {
    // Near-black chrome stays as-is (rail/app-level, outside the Bot skin).
    appChrome: BASE.surface.appChrome,
    /** Page canvas — warm cream. */
    page: d.canvas,
    /** Cards, panels, banners — warm paper. */
    card: d.card,
    /** Inset surface inside cards (inputs, tiles, builder containers). */
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
    soft: d.accentSoft,
    softBorder: d.accentSoftBorder,
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
      shadow: d.shadowCard,
    },
    danger: {
      background: d.card,
      color: d.error,
      border: `1px solid ${d.line}`,
      shadow: d.shadowCard,
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
      border: d.errorBorder,
      accent: d.error,
    },
    attention: {
      ink: d.warningInk,
      bg: d.warningBg,
      bgSoft: d.warningBg,
      border: d.warningBorder,
      accent: d.warning,
    },
    success: {
      ink: d.success,
      bg: d.successBg,
      bgSoft: d.successBg,
      border: d.successBorder,
      accent: d.success,
    },
    info: {
      ink: d.infoInk,
      bg: d.infoBg,
      bgSoft: d.infoBg,
      border: d.infoBorder,
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
