/**
 * Design tokens — single source of truth for the platform.
 *
 * Visual direction: premium SaaS, monochrome slate with restrained semantic
 * accent. Surfaces are white, depth comes from borders + subtle elevation.
 * No tinted card backgrounds; signal lives in chips, accent bars, and avatars.
 */

export const TOKEN = {
  surface: {
    /** Near-black for primary buttons, app icon rail, selected tabs. */
    appChrome: "#0A0A0F",
    /** Cool off-white page background for shells and side panels. */
    page: "#F5F6F8",
    /** Cards, panels, banners — always pure white. */
    card: "#FFFFFF",
    /** Inset surface inside cards: inputs, draft container, business bubble. */
    inset: "#F5F6F8",
    /** Floating overlays (drawer/sheet/dropdown) — always white. */
    overlay: "#FFFFFF",
  },

  /**
   * Dubiz brand — the navy→light-blue gradient is the primary brand expression.
   * Use it for primary actions, active states, selected tabs/stations/filters,
   * central badges. Links/interactive text use {@link brand.mid}. Text stays ink,
   * surfaces stay white — the brand lives in actions and active states, not chrome.
   */
  brand: {
    /** Deep, stable navy — gradient start, solid emphasis on dark surfaces. */
    navy: "#132944",
    /** Soft light blue — gradient end (matches the reference button). */
    denim: "#6F91BE",
    /** @deprecated use denim. */
    light: "#6F91BE",
    /** Middle tone — interactive links, active text, icon accents on white (AA on white). */
    mid: "#2E527F",
    /** Primary action / active gradient (navy → light, matches reference). */
    gradient: "linear-gradient(135deg, #132944 0%, #274A72 48%, #6F91BE 100%)",
    /** Hover — darken the navy side, deepen the light side slightly. */
    gradientHover: "linear-gradient(135deg, #0E2037 0%, #203F64 48%, #5E82B2 100%)",
    /** Soft tinted fill for active/selected surfaces on white. */
    soft: "#EEF3F9",
    /** Border for active/selected surfaces and soft chips. */
    softBorder: "#C7D6E9",
    /** Focus ring — bright-but-restrained brand blue at low alpha. */
    focus: "rgba(46, 82, 127, 0.35)",
    /**
     * WhatsApp channel brand — used ONLY on the WhatsApp connection screens
     * for the connect / reconnect / retry primary action and the glyph.
     * `green` is the official WhatsApp brand color; production should swap the
     * approximated glyph for the licensed asset (Brand Review required).
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
    primary: {
      background: "linear-gradient(135deg, #132944 0%, #274A72 48%, #6F91BE 100%)",
      backgroundHover: "linear-gradient(135deg, #0E2037 0%, #203F64 48%, #5E82B2 100%)",
      color: "#FFFFFF",
      border: "1px solid rgba(255, 255, 255, 0.22)",
      shadow: "0 14px 30px rgba(19, 41, 68, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.28)",
      shadowSoft: "0 10px 22px rgba(19, 41, 68, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.24)",
    },
    glass: {
      background: "rgba(255, 255, 255, 0.78)",
      backgroundHover: "rgba(255, 255, 255, 0.92)",
      color: "#132944",
      border: "1px solid rgba(111, 145, 190, 0.34)",
      shadow: "0 8px 20px rgba(19, 41, 68, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.72)",
    },
    danger: {
      background: "#FFFFFF",
      color: "#991B1B",
      border: "1px solid #FECACA",
      shadow: "0 8px 18px rgba(153, 27, 27, 0.08)",
    },
  },

  ink: {
    /** Primary content + buttons. */
    primary: "#0A0A0F",
    /** Secondary text — sub-lines, labels in lists. */
    secondary: "#4B5563",
    /** Muted text — captions, supporting metadata. */
    muted: "#6B7280",
    /** Meta — timestamps, counts, less-prominent labels. */
    meta: "#9CA3AF",
    /** Disabled/placeholder. */
    disabled: "#D1D5DB",
    /** On dark surfaces (rail, primary buttons). */
    inverse: "#FFFFFF",
  },

  border: {
    /** Single canonical border for cards, inputs, separators. */
    DEFAULT: "#E5E7EB",
    /** Hover state border. */
    hover: "#D1D5DB",
    /** Selection / active emphasis — uses ink primary. */
    strong: "#0A0A0F",
    transparent: "transparent",
  },

  semantic: {
    urgent: {
      ink: "#991B1B",
      bg: "#FEE2E2",
      bgSoft: "#FEF2F2",
      border: "#FECACA",
      accent: "#DC2626",
    },
    attention: {
      ink: "#92400E",
      bg: "#FEF3C7",
      bgSoft: "#FFFBEB",
      border: "#FDE68A",
      accent: "#F59E0B",
    },
    success: {
      ink: "#065F46",
      bg: "#D1FAE5",
      bgSoft: "#ECFDF5",
      border: "#A7F3D0",
      accent: "#10B981",
    },
    info: {
      ink: "#1E40AF",
      bg: "#DBEAFE",
      bgSoft: "#EFF6FF",
      border: "#BFDBFE",
      accent: "#3B82F6",
    },
  },

  /** Saturated avatar backgrounds — white text inside. */
  avatar: {
    red: "#EF4444",
    orange: "#F97316",
    amber: "#F59E0B",
    green: "#10B981",
    blue: "#3B82F6",
    purple: "#8B5CF6",
    pink: "#EC4899",
    slate: "#64748B",
  },

  /** Payment Secretary / Business Memory visual language. */
  secretary: {
    ink: "#0F1729",
    muted: "#6B7280",
    line: "#E1E7EF",
    canvas: "#FFFFFF",
    surface: "#F5F7F9",
    surface2: "#EEF1F6",
    action: "#0F6FFF",
    grad: "linear-gradient(100deg, #17334F 0%, #3D608F 58%, #7597C7 100%)",
    brand: "#17334F",
    brandShadow: "0 16px 34px rgba(23, 51, 79, 0.28)",
    primaryShadow: "0 18px 34px rgba(23, 51, 79, 0.26)",
    focusShadow: "0 18px 44px rgba(15, 23, 42, 0.10)",
    hi: "#22C55E",
    hiBg: "#DCFCE7",
    hiInk: "#166534",
    md: "#F59E0B",
    mdBg: "#FEF3C7",
    mdInk: "#92400E",
    lo: "#14B8A6",
    loBg: "#CCFBF1",
    loInk: "#0F766E",
    infoBg: "#E0EDFF",
    infoInk: "#1D4ED8",
    calm: "#14B8A6",
    calmBg: "#CCFBF1",
    calmInk: "#0F766E",
    purple: "#8B5CF6",
    purpleBg: "#EDE9FE",
    purpleInk: "#5B21B6",
    neutralText: "#64748B",
    softIcon: "#DBEAFE",
    selectedBorder: "#86EFAC",
    dashedBorder: "#CBD5E1",
    sheetDim: "rgba(15, 23, 42, 0.45)",
    activeRing: "rgba(15, 111, 255, 0.18)",
    homeWash:
      "linear-gradient(180deg, rgba(239, 246, 255, 0.92) 0%, rgba(255, 255, 255, 0.98) 42%, #FFFFFF 100%)",
    homeShadowSoft:
      "0 18px 44px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04)",
    homeShadowLift:
      "0 24px 60px rgba(15, 23, 42, 0.12), 0 6px 16px rgba(15, 23, 42, 0.06)",
    homeGoColor: "#2E527F",
  },

  /**
   * Dubiz Design System v1 — the warm cream/teal visual language extracted from
   * the Collection reference (docs Dubiz Design System v1). Additive: features
   * migrate onto this palette one at a time; the Secretary is the first.
   * Values are the DS source-of-truth — do not invent or alter them.
   */
  dsv1: {
    canvas: "#FEF8F2",
    card: "#FDF4EB",
    surface2: "#F6ECDD",
    ink: "#2D2B28",
    muted: "#777067",
    tertiary: "#A79C8D",
    line: "#E9DDD0",
    accent: "#246966",
    gradient: "linear-gradient(115deg, #246966 0%, #2C7C79 52%, #3D9C9A 100%)",
    gradientHover: "linear-gradient(115deg, #2A7370 0%, #348C89 52%, #49AEAC 100%)",
    onAccent: "#FEF8F2",
    success: "#246966",
    successBg: "rgba(36, 105, 102, 0.10)",
    warning: "#B88755",
    warningInk: "#8A6238",
    warningBg: "rgba(184, 135, 85, 0.12)",
    error: "#B85C3F",
    errorBg: "rgba(184, 92, 63, 0.10)",
    info: "#3D9C9A",
    infoInk: "#2A6E6B",
    infoBg: "rgba(61, 156, 154, 0.12)",
    ring: "rgba(36, 105, 102, 0.22)",
    backdrop: "rgba(70, 50, 30, 0.35)",
    shadowCard: "0 1px 2px rgba(88, 62, 38, 0.05), 0 8px 22px rgba(120, 88, 52, 0.06)",
    shadowCardHover: "0 1px 2px rgba(88, 62, 38, 0.06), 0 12px 28px rgba(120, 88, 52, 0.10)",
    shadowGlow: "0 6px 18px rgba(36, 105, 102, 0.28)",
    shadowGlowHover: "0 6px 18px rgba(36, 105, 102, 0.38)",
    shadowOverlay: "0 20px 60px rgba(70, 50, 30, 0.18)",
    homeWash:
      "linear-gradient(180deg, rgba(254, 248, 242, 0.92) 0%, rgba(253, 244, 235, 0.98) 42%, #FDF4EB 100%)",
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

  shadow: {
    none: "none",
    /** Resting cards — works alongside a 1px border. */
    elevated: "0 1px 3px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.03)",
    /** Floating overlays — drawer, sheet, dropdown. */
    floating:
      "0 10px 25px -5px rgba(15, 23, 42, 0.10), 0 4px 6px -4px rgba(15, 23, 42, 0.04)",
    /** App rail edge shadow. */
    nav: "4px 0 16px rgba(0, 0, 0, 0.04)",
  },

  transition: {
    fast: "100ms ease-out",
    base: "150ms ease-out",
    slow: "250ms ease-out",
  },
} as const;

export type Token = typeof TOKEN;
export type UrgencyTier = "urgent" | "attention" | "calm";
export type AvatarColor = keyof typeof TOKEN.avatar;
