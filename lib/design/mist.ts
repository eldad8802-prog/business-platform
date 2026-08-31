/**
 * Dubiz Mist — the TypeScript face of the platform colour system.
 *
 * The VALUES live in `app/dubiz-mist.css` (the single source of truth). This
 * module exposes them as `var(--dz-*, <flat fallback>)` strings so inline
 * styles — which is how ~1,100 Dubiz surfaces are painted — resolve through
 * the same custom properties as CSS-styled surfaces. One consequence matters:
 * a route-scoped override (the Home exclusion, `[data-dz-home]`) reaches
 * inline-styled components too, which a baked hex could never do.
 *
 * `lib/design/tokens.ts` re-points the entire legacy TOKEN surface at this
 * module, so no feature file needs to change to receive Dubiz Mist.
 *
 * RULES
 *  - Surface values (`surface`, `surfaceStrong`, `surfaceRaised`) carry an
 *    IMAGE stack, so they are only ever valid in the `background` shorthand —
 *    never in `backgroundColor`. Use `flat.*` where a pure colour is required
 *    (canvas, SVG, generated PDF/e-mail HTML, `backgroundColor`).
 *  - Never hand-author a colour here. Add the variable in `dubiz-mist.css`
 *    and mirror it below; `npm run verify:mist-tokens` enforces the pairing.
 */

/** `var(--name, fallback)` — the fallback only applies before CSS loads. */
const v = (name: string, fallback: string) => `var(${name}, ${fallback})`;

/**
 * Flat colours — the literal values, mirrored from `app/dubiz-mist.css`.
 * Use these where a CSS custom property cannot reach: `backgroundColor`,
 * canvas/SVG paint, server-generated PDF or e-mail HTML, colour maths.
 */
export const MIST_FLAT = {
  background: "#f4f5f0",
  surface: "#fcfcfa",
  surfaceMuted: "#eff1eb",
  surfaceRaised: "#ffffff",
  appChrome: "#23302b",

  border: "#e3e5dd",
  borderSubtle: "#edefe8",
  borderStrong: "#d2d5c9",

  textPrimary: "#23302b",
  textSecondary: "#566159",
  textMuted: "#666f65",
  textDisabled: "#a8afa4",
  textOnBrand: "#fbfaf6",

  brand: "#246966",
  brandHover: "#1c5451",
  brandSoft: "#e6efec",
  brandSoftStrong: "#d9e7e3",
  brandBorder: "#bfd7d2",

  success: "#1e6a4a",
  successBg: "#e7f1e9",
  successBgSoft: "#f1f7f2",
  successBorder: "#c6dfce",
  successAccent: "#3e8f68",

  warning: "#815a32",
  warningBg: "#f6efe2",
  warningBgSoft: "#fbf7ef",
  warningBorder: "#e6d7be",
  warningAccent: "#b98a4e",

  danger: "#9b4634",
  dangerBg: "#f7eae6",
  dangerBgSoft: "#fcf4f1",
  dangerBorder: "#edd3cb",
  dangerAccent: "#c2664f",

  info: "#2b5a85",
  infoBg: "#e7f0f6",
  infoBgSoft: "#f2f7fa",
  infoBorder: "#c7dbea",
  infoAccent: "#5185b0",
} as const;

/**
 * The token surface every consumer should read. Values resolve through
 * `--dz-*`, so the palette (and the Home freeze) is controlled from CSS.
 */
export const MIST = {
  /** App canvas — flat and even (§1: no visible side-to-side gradient). */
  background: v("--dz-background", MIST_FLAT.background),
  /**
   * Card / panel / section surface WITH the Mist treatment. `background` only.
   */
  surface: v("--dz-surface", MIST_FLAT.surface),
  /** Feature / hero panels — the same diffusion, a touch more present. */
  surfaceStrong: v("--dz-surface-strong", MIST_FLAT.surface),
  /** Floating overlays (dialog / drawer / sheet / dropdown). */
  surfaceRaised: v("--dz-surface-raised", MIST_FLAT.surfaceRaised),
  /** Inset surface — inputs, table stripes, chips (§3: clean, no diffusion). */
  surfaceMuted: v("--dz-surface-muted", MIST_FLAT.surfaceMuted),
  /** Deep chrome (rail, inverted panels) — graphite green, never pure black. */
  appChrome: v("--dz-app-chrome", MIST_FLAT.appChrome),

  border: v("--dz-border", MIST_FLAT.border),
  borderSubtle: v("--dz-border-subtle", MIST_FLAT.borderSubtle),
  borderStrong: v("--dz-border-strong", MIST_FLAT.borderStrong),

  textPrimary: v("--dz-text-primary", MIST_FLAT.textPrimary),
  textSecondary: v("--dz-text-secondary", MIST_FLAT.textSecondary),
  textMuted: v("--dz-text-muted", MIST_FLAT.textMuted),
  textDisabled: v("--dz-text-disabled", MIST_FLAT.textDisabled),
  textOnBrand: v("--dz-text-on-brand", MIST_FLAT.textOnBrand),

  brand: v("--dz-brand", MIST_FLAT.brand),
  brandHover: v("--dz-brand-hover", MIST_FLAT.brandHover),
  brandSoft: v("--dz-brand-soft", MIST_FLAT.brandSoft),
  brandSoftStrong: v("--dz-brand-soft-strong", MIST_FLAT.brandSoftStrong),
  brandBorder: v("--dz-brand-border", MIST_FLAT.brandBorder),
  focusRing: v("--dz-focus-ring", "rgba(36, 105, 102, 0.32)"),
  brandGradient: v(
    "--dz-brand-gradient",
    "linear-gradient(115deg, #246966 0%, #28706e 52%, #2b7a78 100%)",
  ),
  brandGradientHover: v(
    "--dz-brand-gradient-hover",
    "linear-gradient(115deg, #1c5451 0%, #21615e 52%, #246966 100%)",
  ),

  success: v("--dz-success", MIST_FLAT.success),
  successBg: v("--dz-success-bg", MIST_FLAT.successBg),
  successBgSoft: v("--dz-success-bg-soft", MIST_FLAT.successBgSoft),
  successBorder: v("--dz-success-border", MIST_FLAT.successBorder),
  successAccent: v("--dz-success-accent", MIST_FLAT.successAccent),

  warning: v("--dz-warning", MIST_FLAT.warning),
  warningBg: v("--dz-warning-bg", MIST_FLAT.warningBg),
  warningBgSoft: v("--dz-warning-bg-soft", MIST_FLAT.warningBgSoft),
  warningBorder: v("--dz-warning-border", MIST_FLAT.warningBorder),
  warningAccent: v("--dz-warning-accent", MIST_FLAT.warningAccent),

  danger: v("--dz-danger", MIST_FLAT.danger),
  dangerBg: v("--dz-danger-bg", MIST_FLAT.dangerBg),
  dangerBgSoft: v("--dz-danger-bg-soft", MIST_FLAT.dangerBgSoft),
  dangerBorder: v("--dz-danger-border", MIST_FLAT.dangerBorder),
  dangerAccent: v("--dz-danger-accent", MIST_FLAT.dangerAccent),

  info: v("--dz-info", MIST_FLAT.info),
  infoBg: v("--dz-info-bg", MIST_FLAT.infoBg),
  infoBgSoft: v("--dz-info-bg-soft", MIST_FLAT.infoBgSoft),
  infoBorder: v("--dz-info-border", MIST_FLAT.infoBorder),
  infoAccent: v("--dz-info-accent", MIST_FLAT.infoAccent),

  shadowCard: v(
    "--dz-shadow-card",
    "0 1px 2px rgba(52, 60, 50, 0.04), 0 10px 28px -14px rgba(52, 60, 50, 0.14)",
  ),
  shadowCardHover: v(
    "--dz-shadow-card-hover",
    "0 1px 2px rgba(52, 60, 50, 0.05), 0 16px 36px -16px rgba(52, 60, 50, 0.18)",
  ),
  shadowRaised: v(
    "--dz-shadow-raised",
    "0 1px 2px rgba(52, 60, 50, 0.05), 0 18px 44px -20px rgba(52, 60, 50, 0.2)",
  ),
  shadowOverlay: v(
    "--dz-shadow-overlay",
    "0 24px 64px -24px rgba(35, 48, 43, 0.26)",
  ),
  shadowGlow: v("--dz-shadow-glow", "0 6px 18px -4px rgba(36, 105, 102, 0.24)"),
  shadowGlowHover: v(
    "--dz-shadow-glow-hover",
    "0 8px 22px -4px rgba(36, 105, 102, 0.3)",
  ),
  backdrop: v("--dz-backdrop", "rgba(35, 48, 43, 0.38)"),
} as const;

export type MistToken = typeof MIST;
