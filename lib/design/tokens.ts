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

  /** Strict radius scale — 5 values only. */
  radius: {
    chip: 6,
    button: 8,
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
