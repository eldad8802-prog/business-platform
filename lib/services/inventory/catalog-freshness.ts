import { CatalogAttribute } from "@prisma/client";

/**
 * Supplier Domain Catalog — Freshness (pure, runtime-only).
 *
 * Freshness is DERIVED, never stored (no `stale` / `expiresAt` / `freshnessScore`
 * columns). A catalog claim stays true-in-time forever; freshness only decays the
 * *advisory* weight of the current read-model. Windows are attribute-specific
 * static policy (Cross-Cutting Law #9 — confidence decays with time).
 */

const DAY_MS = 86_400_000;

/** Attribute-specific volatility window in days. Static policy — never stored. */
export function attributeFreshnessWindowDays(attribute: CatalogAttribute): number {
  switch (attribute) {
    case "AVAILABILITY":
      return 1; // hours-volatile
    case "ASKING_PRICE":
    case "MINIMUM_ORDER_AMOUNT":
      return 14; // weeks
    case "PACKAGE_DESCRIPTION":
    case "LEAD_TIME_DAYS":
      return 180; // months (stable)
    default:
      return 30;
  }
}

export type Freshness = {
  state: "FRESH" | "STALE";
  ageDays: number;
  /** 1 = just asserted … 0 = fully decayed. Advisory confidence multiplier. */
  freshnessRatio: number;
};

/** Derive freshness for a claim from its as-of time. Pure; nothing is stored. */
export function computeFreshness(
  attribute: CatalogAttribute,
  asOf: Date,
  now: Date = new Date()
): Freshness {
  const window = attributeFreshnessWindowDays(attribute);
  const ageDays = Math.max(0, (now.getTime() - asOf.getTime()) / DAY_MS);
  const freshnessRatio = Math.max(0, Math.min(1, 1 - ageDays / window));
  return {
    state: ageDays <= window ? "FRESH" : "STALE",
    ageDays,
    freshnessRatio,
  };
}
