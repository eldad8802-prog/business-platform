/**
 * Design tokens — single source of truth for the platform.
 *
 * Visual direction: **Dubiz Mist**. A warm off-white ground with a very subtle
 * misty-sage undertone; surfaces are near-white paper that receive an ambient,
 * borderless colour diffusion; depth comes from hairlines and wide, low-opacity
 * shadows; the Dubiz teal carries every primary action and active state.
 *
 * Every colour below resolves through `lib/design/mist.ts` → `--dz-*` custom
 * properties declared in `app/dubiz-mist.css`. NOTHING in this file is a
 * hand-authored colour: to change the palette, change the stylesheet.
 * `npm run verify:mist-tokens` proves the three layers stay in step.
 *
 * The historical split between the "cool" set (`surface`/`brand`/`ink`) and the
 * "warm" DS v1 set (`dsv1`/`warm`) is retained as an API — ~120 files import one
 * or the other — but both now resolve to the SAME Mist values, so the product
 * finally speaks one language. The duplicate groups are kept (rather than
 * deleted) purely so no call site has to change; new code should read `dsv1`.
 *
 * IMPORTANT: `surface.card` / `surface.overlay` / `dsv1.card` and friends carry
 * a background-IMAGE stack (that is the Mist treatment). They are valid in the
 * `background` shorthand only — never in `backgroundColor`. Where a flat colour
 * is genuinely required (canvas, SVG paint, server-rendered PDF/e-mail HTML),
 * import `MIST_FLAT` from `lib/design/mist.ts`.
 */

import { MIST } from "./mist";

export const TOKEN = {
  surface: {
    /** Deep chrome for inverted panels/rails — graphite green, never pure black. */
    appChrome: MIST.appChrome,
    /** Page ground — flat and even (§1: the diffusion lives on the surfaces). */
    page: MIST.background,
    /** Cards, panels, banners — near-white paper carrying the Mist treatment. */
    card: MIST.surface,
    /** Inset surface inside cards: inputs, tiles, draft containers — clean, no diffusion. */
    inset: MIST.surfaceMuted,
    /** Floating overlays (drawer/sheet/dropdown/dialog). */
    overlay: MIST.surfaceRaised,
    /** Hero / feature panels — the same diffusion, a touch more present. */
    feature: MIST.surfaceStrong,
  },

  /**
   * Dubiz brand — the teal taken from the logo. It carries primary actions and
   * active states; surfaces stay near-white and text stays ink, so the brand
   * lives in actions and selection, never in chrome.
   */
  brand: {
    /** @deprecated historical name for the deep brand tone — now the teal. */
    navy: MIST.brand,
    /** @deprecated historical gradient tail — now the teal accent. */
    denim: MIST.infoAccent,
    /** @deprecated use `mid`. */
    light: MIST.infoAccent,
    /** Interactive links, active text, icon accents (AA on every Mist ground). */
    mid: MIST.brand,
    /** Primary action / active gradient — soft, premium, never neon. */
    gradient: MIST.brandGradient,
    /** Hover deepens rather than brightens. */
    gradientHover: MIST.brandGradientHover,
    /** Soft mist fill for active/selected surfaces (nav selection, soft chips). */
    soft: MIST.brandSoft,
    /** Border for active/selected surfaces and soft chips. */
    softBorder: MIST.brandBorder,
    /** Focus ring — the brand teal at low alpha. */
    focus: MIST.focusRing,
    /**
     * WhatsApp channel brand — used ONLY on the WhatsApp connection screens
     * for the connect / reconnect / retry primary action and the glyph.
     * `green` is the official WhatsApp brand colour and is deliberately NOT
     * re-tinted by Dubiz Mist (it represents WhatsApp, not Dubiz); production
     * should swap the approximated glyph for the licensed asset.
     */
    whatsapp: {
      green: "#25D366",
      gradient: "linear-gradient(140deg, #25D366 0%, #1EBE5B 100%)",
      ink: "#FFFFFF",
      shadow:
        "0 10px 22px rgba(37, 211, 102, 0.30), 0 3px 8px rgba(37, 211, 102, 0.20)",
    },
  },

  action: {
    /**
     * The Dubiz primary CTA. Reads the ROLE token, not the brand gradient:
     * a flat, restrained fill that hover/active deepen. Every token-driven
     * primary button in the product resolves through here.
     */
    primary: {
      background: MIST.actionPrimary,
      backgroundHover: MIST.actionPrimaryHover,
      color: MIST.actionPrimaryText,
      border: "0",
      shadow: MIST.actionPrimaryShadow,
      shadowSoft: MIST.actionPrimaryShadow,
    },
    /** Secondary action (§5): off-white surface, subtle border, muted dark ink. */
    glass: {
      // Reads the secondary ROLE token so [data-dz-action="secondary"]:hover
      // can rebind it. Pointing at a surface token directly would leave the
      // hover rule rebinding a variable this element never reads.
      background: MIST.actionSecondaryBg,
      backgroundHover: MIST.actionSecondaryHover,
      color: MIST.actionSecondaryText,
      border: `1px solid ${MIST.actionSecondaryBorder}`,
      shadow: MIST.shadowCard,
    },
    danger: {
      background: MIST.surfaceRaised,
      color: MIST.danger,
      border: `1px solid ${MIST.dangerBorder}`,
      shadow: MIST.shadowCard,
    },
  },

  ink: {
    /** Primary content — deep graphite green-black, never pure black (§7). */
    primary: MIST.textPrimary,
    /** Secondary text — sub-lines, labels in lists. */
    secondary: MIST.textSecondary,
    /** Muted text — captions, supporting metadata. */
    muted: MIST.textMuted,
    /**
     * Meta — timestamps, counts, less-prominent labels. Folded onto `muted`:
     * the pre-Mist value (#9CA3AF) sat at 2.4:1 and failed WCAG AA as real
     * text. The hierarchy loses one step; legibility gains a whole tier.
     */
    meta: MIST.textMuted,
    /** Disabled/placeholder (WCAG 1.4.3 exempts disabled controls). */
    disabled: MIST.textDisabled,
    /** On the brand gradient / deep chrome. */
    inverse: MIST.textOnBrand,
  },

  border: {
    /** Single canonical hairline for cards, inputs, separators (§8). */
    DEFAULT: MIST.border,
    /** Hover state border. */
    hover: MIST.borderStrong,
    /** Selection / active emphasis — the brand teal, never black. */
    strong: MIST.brand,
    transparent: "transparent",
  },

  /**
   * Semantic signals (§10) — the meaning is untouched (success = green,
   * warning = amber, danger = red, info = blue); only the saturation is
   * softened so the signals sit calmly on the Mist ground. Every ink/bg pair
   * below is AA-verified by `verify:mist-tokens`.
   */
  semantic: {
    urgent: {
      ink: MIST.danger,
      bg: MIST.dangerBg,
      bgSoft: MIST.dangerBgSoft,
      border: MIST.dangerBorder,
      accent: MIST.dangerAccent,
    },
    attention: {
      ink: MIST.warning,
      bg: MIST.warningBg,
      bgSoft: MIST.warningBgSoft,
      border: MIST.warningBorder,
      accent: MIST.warningAccent,
    },
    success: {
      ink: MIST.success,
      bg: MIST.successBg,
      bgSoft: MIST.successBgSoft,
      border: MIST.successBorder,
      accent: MIST.successAccent,
    },
    info: {
      ink: MIST.info,
      bg: MIST.infoBg,
      bgSoft: MIST.infoBgSoft,
      border: MIST.infoBorder,
      accent: MIST.infoAccent,
    },
  },

  /**
   * Avatar backgrounds — identity colours, white text inside. Hue identity is
   * preserved; saturation is pulled back into the Mist range, and every value
   * clears 4.3:1 against `ink.inverse` (they were previously as low as 2.1:1).
   */
  avatar: {
    red: "#A4503F",
    orange: "#9F5F39",
    amber: "#8A6731",
    green: "#2F7A57",
    blue: "#3F6E96",
    purple: "#67588F",
    pink: "#93506F",
    slate: "#5C665E",
  },

  /**
   * Payment Secretary / Business Memory visual language.
   *
   * Historical group with no current consumers (the Secretary reads `dsv1` via
   * `secretaryVars()`). Re-pointed at Mist so it cannot become a cool-navy
   * island if something adopts it again.
   */
  secretary: {
    ink: MIST.textPrimary,
    muted: MIST.textMuted,
    line: MIST.border,
    canvas: MIST.surface,
    surface: MIST.background,
    surface2: MIST.surfaceMuted,
    action: MIST.brand,
    grad: MIST.brandGradient,
    brand: MIST.brand,
    brandShadow: MIST.shadowGlow,
    primaryShadow: MIST.shadowGlow,
    focusShadow: MIST.shadowRaised,
    hi: MIST.successAccent,
    hiBg: MIST.successBg,
    hiInk: MIST.success,
    md: MIST.warningAccent,
    mdBg: MIST.warningBg,
    mdInk: MIST.warning,
    lo: MIST.brand,
    loBg: MIST.brandSoft,
    loInk: MIST.brand,
    infoBg: MIST.infoBg,
    infoInk: MIST.info,
    calm: MIST.brand,
    calmBg: MIST.brandSoft,
    calmInk: MIST.brand,
    purple: "#67588F",
    purpleBg: "#EDEAF3",
    purpleInk: "#514279",
    neutralText: MIST.textMuted,
    softIcon: MIST.brandSoft,
    selectedBorder: MIST.brandBorder,
    dashedBorder: MIST.borderStrong,
    sheetDim: MIST.backdrop,
    activeRing: MIST.focusRing,
    homeWash: MIST.surface,
    homeShadowSoft: MIST.shadowCard,
    homeShadowLift: MIST.shadowCardHover,
    homeGoColor: MIST.brand,
  },

  /**
   * Dubiz Design System v1 — the platform palette group. Originally the warm
   * cream/teal set; now the **Dubiz Mist** identity. This is the hub every
   * feature theme (`documents-theme`, `billing-theme`, `bot-theme`,
   * `crm-theme`, `inventory-tokens`, `warm-primitives`, `marketing-tokens`,
   * `secretaryVars`) derives from — change it here, and the whole product
   * follows. Values come from `MIST`; never invent or alter one.
   */
  dsv1: {
    /** Page ground — flat, even, calm. */
    canvas: MIST.background,
    /** Card / panel paper, carrying the Mist diffusion. */
    card: MIST.surface,
    /** Inset surface — inputs, tiles, segmented backgrounds. */
    surface2: MIST.surfaceMuted,
    /** Floating overlay paper (dialog / drawer / sheet). */
    overlay: MIST.surfaceRaised,
    /** Hero / feature panel — a touch more diffusion. */
    feature: MIST.surfaceStrong,
    ink: MIST.textPrimary,
    muted: MIST.textSecondary,
    tertiary: MIST.textMuted,
    line: MIST.border,
    /** Hairline for quiet separators inside a surface. */
    lineSubtle: MIST.borderSubtle,
    accent: MIST.brand,
    accentHover: MIST.brandHover,
    /** Soft mist fill for active/selected surfaces and soft chips. */
    accentSoft: MIST.brandSoft,
    accentSoftStrong: MIST.brandSoftStrong,
    accentSoftBorder: MIST.brandBorder,
    gradient: MIST.brandGradient,
    gradientHover: MIST.brandGradientHover,
    onAccent: MIST.textOnBrand,
    /**
     * Interaction roles. Feature themes read THESE for controls; `gradient`
     * stays available for genuinely decorative brand surfaces (hero panels,
     * meters, badges) where a gradient is the point.
     */
    actionPrimary: MIST.actionPrimary,
    actionPrimaryHover: MIST.actionPrimaryHover,
    actionPrimaryActive: MIST.actionPrimaryActive,
    actionPrimaryText: MIST.actionPrimaryText,
    actionPrimaryShadow: MIST.actionPrimaryShadow,
    selectionBg: MIST.selectionBg,
    selectionBgHover: MIST.selectionBgHover,
    selectionText: MIST.selectionText,
    selectionBorder: MIST.selectionBorder,
    controlHover: MIST.controlHover,
    actionSecondaryBg: MIST.actionSecondaryBg,
    actionSecondaryHover: MIST.actionSecondaryHover,
    actionSecondaryBorder: MIST.actionSecondaryBorder,
    actionSecondaryText: MIST.actionSecondaryText,
    /**
     * Semantic signals. DS v1 originally folded `success` onto the brand teal;
     * Dubiz Mist §10 restores the real green so success/warning/danger/info
     * keep their meaning. Brand-soft fills now read `accentSoft` instead.
     */
    success: MIST.success,
    successBg: MIST.successBg,
    successBorder: MIST.successBorder,
    warning: MIST.warningAccent,
    warningInk: MIST.warning,
    warningBg: MIST.warningBg,
    warningBorder: MIST.warningBorder,
    error: MIST.danger,
    errorBg: MIST.dangerBg,
    errorBorder: MIST.dangerBorder,
    info: MIST.infoAccent,
    infoInk: MIST.info,
    infoBg: MIST.infoBg,
    infoBorder: MIST.infoBorder,
    ring: MIST.focusRing,
    backdrop: MIST.backdrop,
    shadowCard: MIST.shadowCard,
    shadowCardHover: MIST.shadowCardHover,
    shadowGlow: MIST.shadowGlow,
    shadowGlowHover: MIST.shadowGlowHover,
    shadowOverlay: MIST.shadowOverlay,
    homeWash: MIST.surface,
    radius: { field: 12, button: 14, card: 16, dialog: 20, sheet: 24, pill: 999 },
    weight: { light: 300, regular: 400, medium: 500, semibold: 600 },
  },

  /** Strict radius scale — 5 values only. */
  radius: {
    chip: 6,
    button: 18,
    input: 10,
    card: 14,
    modal: 16,
    pill: 999,
  },

  /** Strict 4pt spacing scale. */
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    "2xl": 24,
    "3xl": 32,
    "4xl": 48,
  },

  /** 6 font sizes total. */
  font: {
    caption: 11,
    meta: 12,
    body: 14,
    title: 16,
    display: 20,
    hero: 24,
  },

  /** 4 font weights total — no fake intermediate values. */
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  /** Elevation (§9): reduced, very soft, wide, low opacity. */
  shadow: {
    none: "none",
    /** Resting cards — works alongside a 1px hairline. */
    elevated: MIST.shadowCard,
    /** Floating overlays — drawer, sheet, dropdown. */
    floating: MIST.shadowOverlay,
    /** App rail edge shadow. */
    nav: MIST.shadowCard,
  },

  transition: {
    fast: "100ms ease-out",
    base: "150ms ease-out",
    slow: "250ms ease-out",
  },

  /**
   * Collection / Payments palette group.
   *
   * Historically the isolated "warm" set that coexisted with the cool one.
   * Under Dubiz Mist there is only one language, so this group is now an alias
   * layer over the same `MIST` values — kept so its call sites keep compiling.
   * Prefer `dsv1` in new code.
   */
  warm: {
    canvas: MIST.background,
    surface: MIST.surface,
    surface2: MIST.surfaceMuted,
    ink: MIST.textPrimary,
    muted: MIST.textSecondary,
    muted2: MIST.textMuted,
    line: MIST.border,
    tealDeep: MIST.brand,
    teal: MIST.infoAccent,
    tealLight: MIST.brandSoftStrong,
    brown: MIST.warningAccent,
    brownLight: MIST.warningBorder,
    clay: MIST.dangerAccent,
    /* Primary action fill for the Collection/Payments primitives (WarmButton).
     * The interaction role, not the brand gradient. */
    grad: MIST.actionPrimary,
    gradHover: MIST.actionPrimaryHover,
    shadow: MIST.shadowCard,
    shadowHover: MIST.shadowCardHover,
    glow: MIST.actionPrimaryShadow,
    glowHover: MIST.actionPrimaryShadow,
    /** Warm radii — softer than the cool set. */
    radius: { card: 16, control: 12, cta: 14, pill: 999 },
    /**
     * Truth/status signals. Only two states are real in v1 (waiting ·
     * verified); partial is framed (Billing-owned), late is a derived timing
     * signal. Meanings unchanged — only the palette moved to Mist.
     */
    status: {
      /** באיחור */
      late: { ink: MIST.danger, bg: MIST.dangerBg },
      /** נגבה ואומת */
      verified: { ink: MIST.success, bg: MIST.successBg },
      /** שולם חלקית */
      partial: { ink: MIST.warning, bg: MIST.warningBg },
      /** ממתין */
      waiting: { ink: MIST.textMuted, bg: MIST.surfaceMuted },
    },
  },
} as const;

export type Token = typeof TOKEN;
export type UrgencyTier = "urgent" | "attention" | "calm";
export type AvatarColor = keyof typeof TOKEN.avatar;

/**
 * LAYOUT — the canonical form-factor scale and width authority
 * (Adaptive + Native Architecture Specification v1, §3–§4; owner-approved).
 *
 * These are the ONLY sources for page widths, breakpoints, gutters and
 * z-tiers. Product code never writes a raw px for any of these concerns:
 * a screen picks a PageIntent (via PageContainer), a split picks a scale
 * breakpoint (via WorkspaceLayout), an overlay picks a variant.
 *
 * Breakpoints align 1:1 with ShellChrome's existing tiers (768 rail /
 * 1024 sidebar) and with Tailwind v4 defaults (md/lg/xl) — deliberately.
 */
export const LAYOUT = {
  /** compact <768 · medium 768–1023 · expanded 1024–1279 · wide ≥1280 */
  bp: { medium: 768, expanded: 1024, wide: 1280 },
  /**
   * Page width by INTENT (never by number):
   *   focused  — login / short forms / focused settings
   *   standard — reading, rich wizards, basic CRUD
   *   content  — module hubs / composed home surfaces
   *   data     — lists, tables, dashboards
   *   (workspace/full carry no cap — panes are owned by WorkspaceLayout)
   */
  width: { focused: 560, standard: 760, content: 960, data: 1280 },
  /** Horizontal page gutters per tier (consumed via clamp in PageContainer). */
  gutter: { compact: 16, medium: 24, expanded: 32 },
  /** Mirrors ShellChrome's fixed chrome — single source for offsets. */
  shell: { rail: 76, sidebar: 248, bottomClearance: 100 },
  /** Canonical z tiers — ends the ad-hoc 100/101/2147483000 escalation. */
  z: { nav: 100, fab: 110, overlay: 1300, toast: 1400 },
} as const;

/**
 * Width intents a PageContainer can resolve to a `LAYOUT.width` cap.
 * A screen changes width by changing intent, never by a new literal.
 */
export type PageIntent = "focused" | "standard" | "content" | "data" | "full";

/**
 * The full declared vocabulary of the `data-page-intent` attribute.
 *
 * A workspace surface does not have a single centered column to cap — its
 * geometry belongs to WorkspaceLayout's regions — so it declares its intent
 * on its own root instead of through PageContainer. It is deliberately NOT a
 * `PageIntent`: PageContainer resolves widths, and there is no width to
 * resolve here. Keeping it declared (rather than an ad-hoc string) is what
 * lets CI assert that every product surface states an intent from a known set.
 */
export type PageSurfaceIntent = PageIntent | "workspace";
