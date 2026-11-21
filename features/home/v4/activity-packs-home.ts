/**
 * HOME v4 × activity packs — what each pack puts forward. Pure: no I/O, no React.
 *
 * The approved rule (owner, phase 2): the pack decides CONTENT, ORDER and NAVIGATION; the plan / feature access decides
 * what is AVAILABLE. Every function here therefore starts from what `allows()` already permits and only reorders it:
 * a pack can never add a metric, an action, a tool or a bar slot whose module is OFF or whose scope the person lacks.
 *
 * With no selection (`access.activity === null` — the feature is OFF, or the owner never chose) none of this runs and
 * the Home is exactly the pre-packs HOME v4 (kind order from the category). That is how existing accounts stay as they
 * are until their owner explicitly chooses.
 */
import type { ActivityPackKey, ActivitySelection } from "@/lib/activity-packs/activity-packs";

import type { HomeModule, HomeScope, PackEngine } from "./home-access";

/** The metrics the Home knows how to draw (home-v4-model's MetricKey, repeated as a type-only import target). */
export type PackMetric =
  | "receiptsMonth"
  | "receiptsToday"
  | "openService"
  | "todayTasks"
  | "waitingLeads"
  | "toCollect"
  | "docsReview"
  | "todayAppointments"
  | "lowStock"
  | "readyForPickup";

/** The secretary groups a pack can rank (the five existing kinds + ready-for-pickup from the Service Desk). */
export type PackSecretaryKind = "payment" | "stock" | "collection" | "lead" | "intake" | "serviceReady";

/** A destination the bottom bar's second slot may hold (keys of components/navigation/nav-destinations.tsx). */
export type BarSlotKey = "calendar" | "service-desk" | "inventory" | "leads";

export type PackHome = {
  /** The pack's metrics in priority order: as the PRIMARY pack, the first two available ones are the main pair. */
  metrics: PackMetric[];
  /** The one metric this pack adds when it is an ADDITIONAL pack (shown right after the main pair, in "more"). */
  contributes: PackMetric;
  /** "+" actions (CREATE_ACTIONS keys) in order; an additional pack contributes its first available one. */
  create: string[];
  /** Tool keys (lib/navigation/home-routes.ts) put first in "הכלים שלי"; an additional pack adds its first one. */
  favorites: string[];
  /** Secretary kinds ranked first among items of the SAME urgency (never above a more urgent item). */
  secretary: PackSecretaryKind[];
  /** The bottom bar's second slot: the first candidate whose module is ON. `calendar` always resolves (see below). */
  bar: BarSlotKey[];
};

export const PACK_HOME: Record<ActivityPackKey, PackHome> = {
  APPOINTMENTS: {
    metrics: ["todayAppointments", "receiptsToday", "receiptsMonth", "toCollect", "todayTasks", "waitingLeads", "docsReview"],
    contributes: "todayAppointments",
    create: ["appointment", "invoice", "customer", "payment-request", "task", "upload"],
    favorites: ["calendar", "customers", "invoices", "collection"],
    secretary: ["collection", "stock", "lead"],
    bar: ["calendar"],
  },
  SERVICE: {
    // Service Desk OFF for the business → the first two are not available and the pair falls to takings + low stock.
    metrics: ["openService", "readyForPickup", "receiptsToday", "lowStock", "receiptsMonth", "toCollect", "todayTasks"],
    contributes: "openService",
    create: ["service-case", "invoice", "customer", "product", "appointment", "upload"],
    favorites: ["service-desk", "inventory", "invoices", "customers"],
    secretary: ["serviceReady", "stock", "collection"],
    // Owner decision 2: "קריאות" only while the Service Desk is ON; otherwise מלאי when it is relevant (the inventory
    // pack chosen too) and available; otherwise יומן. The "relevant" part is applied in barSlotFor().
    bar: ["service-desk", "inventory", "calendar"],
  },
  INVENTORY: {
    metrics: ["receiptsToday", "lowStock", "receiptsMonth", "docsReview", "toCollect", "todayTasks"],
    contributes: "lowStock",
    create: ["invoice", "product", "upload", "commitment", "customer", "task"],
    favorites: ["inventory", "suppliers", "invoices", "documents"],
    secretary: ["stock", "collection"],
    bar: ["inventory", "calendar"],
  },
  LEADS: {
    metrics: ["waitingLeads", "toCollect", "receiptsMonth", "todayAppointments", "todayTasks", "docsReview"],
    contributes: "waitingLeads",
    create: ["lead", "payment-request", "invoice", "customer", "appointment", "task"],
    favorites: ["leads", "customers", "conversations", "collection"],
    secretary: ["lead", "intake", "collection"],
    bar: ["leads"],
  },
  ORDERS: {
    // On the EXISTING tools only (no orders / projects module): enquiries, money waiting (deposits are payment
    // requests), the calendar. "אירועים השבוע" from the design needs an events model that does not exist — not drawn.
    metrics: ["waitingLeads", "toCollect", "todayAppointments", "receiptsMonth", "todayTasks"],
    contributes: "toCollect",
    create: ["lead", "invoice", "payment-request", "appointment", "customer", "task"],
    favorites: ["leads", "invoices", "calendar", "collection"],
    secretary: ["lead", "collection"],
    // Owner: the calendar until an orders tool exists.
    bar: ["calendar"],
  },
};

/** The module a bar slot needs. `calendar` needs none: without appointments it opens the Secretary calendar. */
const BAR_SLOT_MODULE: Record<BarSlotKey, HomeModule | null> = {
  calendar: null,
  "service-desk": "service_desk",
  inventory: "inventory",
  leads: null,
};

/** The person scope a bar slot needs (home-access layer 3). `calendar` stays for everyone, as today. */
const BAR_SLOT_SCOPE: Record<BarSlotKey, HomeScope | null> = {
  calendar: null,
  "service-desk": "operations",
  inventory: "operations",
  leads: "customers",
};

/**
 * The bottom bar's second slot. No selection → the fixed יומן (pre-packs HOME v4). Otherwise the primary pack's first
 * candidate whose module is ON and whose scope the person holds — where the SERVICE pack's inventory fallback counts
 * only when the owner also chose the inventory pack (owner decision 2: "מלאי אם הוא רלוונטי וזמין, ואחרת יומן").
 */
export function barSlotFor(
  selection: ActivitySelection | null,
  modules: ReadonlySet<HomeModule>,
  scopes?: ReadonlySet<HomeScope>,
): BarSlotKey {
  if (!selection) return "calendar";
  for (const slot of PACK_HOME[selection.primary].bar) {
    if (selection.primary === "SERVICE" && slot === "inventory" && !selection.additional.includes("INVENTORY")) continue;
    const mod = BAR_SLOT_MODULE[slot];
    const scope = BAR_SLOT_SCOPE[slot];
    if ((mod === null || modules.has(mod)) && (scope === null || !scopes || scopes.has(scope))) return slot;
  }
  return "calendar";
}

/** Primary pack first, then the additional packs in the owner's order. */
export function packsInOrder(selection: ActivitySelection): ActivityPackKey[] {
  return [selection.primary, ...selection.additional];
}

/**
 * Order `available` (already permitted, already in a sensible fallback order) by the selection:
 *   1. the primary pack's list, as far as available — its first two are the main pair;
 *   2. each additional pack's one contribution;
 *   3. the rest of the primary pack's list (already placed), then everything else in fallback order.
 * Never adds anything that is not in `available`.
 */
export function orderMetricsByPacks(selection: ActivitySelection, available: readonly PackMetric[]): PackMetric[] {
  const has = (k: PackMetric): boolean => available.includes(k);
  const primary = PACK_HOME[selection.primary].metrics.filter(has);
  const out: PackMetric[] = [];
  const push = (k: PackMetric) => {
    if (!out.includes(k)) out.push(k);
  };
  primary.slice(0, 2).forEach(push);
  for (const p of selection.additional) {
    const c = PACK_HOME[p].contributes;
    if (has(c)) push(c);
  }
  primary.slice(2).forEach(push);
  available.forEach(push);
  return out;
}

/** Same idea for the "+" actions and the tools: primary list, then one per additional pack, then the rest. */
export function orderKeysByPacks<T>(
  selection: ActivitySelection,
  items: readonly T[],
  keyOf: (t: T) => string,
  listOf: (p: PackHome) => string[],
): T[] {
  const byKey = new Map(items.map((t) => [keyOf(t), t] as const));
  const out: T[] = [];
  const push = (k: string) => {
    const t = byKey.get(k);
    if (t !== undefined && !out.includes(t)) out.push(t);
  };
  listOf(PACK_HOME[selection.primary]).forEach(push);
  for (const p of selection.additional) {
    const first = listOf(PACK_HOME[p]).find((k) => byKey.has(k) && !out.includes(byKey.get(k) as T));
    if (first) push(first);
  }
  items.forEach((t) => push(keyOf(t)));
  return out;
}

/** The secretary tie-breaker: the position of a kind in the selection's priority (lower first), or Infinity. */
export function secretaryPackRank(selection: ActivitySelection, kind: PackSecretaryKind): number {
  let i = 0;
  for (const p of packsInOrder(selection)) {
    for (const k of PACK_HOME[p].secretary) {
      if (k === kind) return i;
      i++;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Default favourite tool keys with packs: `lead` (the tools that left the bar) first, the primary pack's, then one
 * per additional pack.
 */
export function packFavoriteKeys(selection: ActivitySelection, lead: readonly string[]): string[] {
  const keys: string[] = [...lead];
  const push = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
  };
  PACK_HOME[selection.primary].favorites.forEach(push);
  for (const p of selection.additional) {
    const first = PACK_HOME[p].favorites.find((k) => !keys.includes(k));
    if (first) push(first);
  }
  return keys;
}

/**
 * The engine object the Home / bar / "+" / tools receive once it is loaded (pack-engine-loader.ts). Loaded on demand,
 * only for a business that chose packs, so none of these tables ship with the pages of a business that did not.
 */
export const PACK_ENGINE: PackEngine = {
  orderMetrics: <K extends string>(selection: ActivitySelection, permitted: readonly K[]): K[] =>
    orderMetricsByPacks(selection, permitted as readonly string[] as readonly PackMetric[]) as string[] as K[],
  orderKeys: (selection, items, keyOf, list) => orderKeysByPacks(selection, items, keyOf, (p) => p[list]),
  secretaryRank: (selection, kind) => secretaryPackRank(selection, kind as PackSecretaryKind),
  favoriteKeys: packFavoriteKeys,
  barSlot: barSlotFor,
};
