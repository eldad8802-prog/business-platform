/**
 * Coupon consumer-zone palette — ADDITIVE, isolated.
 *
 * The public / discovery surfaces (marketplace, public coupon page, personal
 * coupon) use a celebratory *colored thema* on top of the shared warm base
 * (`TOKEN.warm`). This module ONLY adds the thema/accent colors — it never
 * touches or overrides `TOKEN.warm`, and the business-owner internal tools keep
 * using the calm warm palette. Two zones, one language.
 *
 * Source of truth: docs/coupon/coupon_screens_all.html (:root). Weights stay
 * ≤600 everywhere these are consumed.
 */
export const COUPON = {
  /** Ticket / hero header gradients — one per business "thema". */
  thema: {
    teal: "linear-gradient(135deg, #1F7D6F, #3DB0A6)",
    orange: "linear-gradient(135deg, #E67E3A, #F2A65C)",
    purple: "linear-gradient(135deg, #6E52A6, #9179C4)",
    pink: "linear-gradient(135deg, #C24D80, #E483AA)",
  },
  /** Discovery accents (category dots, ribbons, facts). */
  accent: {
    coral: "#E67E3A",
    violet: "#8A6FBE",
    amber: "#BE8B3C",
    whatsapp: "#1FA855",
    clay: "#B85C3F",
  },
  /** Category → dot color (food / beauty / health seed set). */
  categoryDot: {
    food: "#E67E3A",
    beauty: "#8A6FBE",
    health: "#3D9C9A",
  },
} as const;

export type CouponThema = keyof typeof COUPON.thema;
