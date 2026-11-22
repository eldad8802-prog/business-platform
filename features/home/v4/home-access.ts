/**
 * HOME v4 — the three access layers the Home is drawn from, kept apart on purpose.
 *
 *   1. PLAN  — which capabilities the business has. The product has NO subscription / plan / tier model today;
 *              the only real source is per-business platform feature access (GET /api/business/capabilities,
 *              resolved by lib/services/feature-access/resolve-feature-access.ts). `HomeModules` is built ONLY from
 *              that answer. When a plan model exists, it feeds the same resolver — this file does not change.
 *   2. KIND  — which capabilities to put forward. Derived from BusinessProfile.category / businessModel
 *              (lib/business/business-categories.ts). Emphasis only: it never grants anything.
 *   3. USER  — what this person may see. The product has no in-business roles today (one user per business, who
 *              is its owner — see side-nav.tsx "memberships"). `UserPermissions` is the seam a future role source
 *              plugs into; today it is resolved from that one fact and nothing else.
 *
 * Everything here is UI only. Hiding an entry is never the protection: every route still enforces its own flag
 * and tenant on the server (tasks-http, appointments-http, service-desk gate, business-documents route…).
 */

import type { ActivitySelection } from "@/lib/activity-packs/activity-packs";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { BarSlotKey } from "./activity-packs-home";

/** The modules the Home knows how to draw. Each maps to exactly one real platform feature key (or none = core). */
export type HomeModule =
  | "billing"
  | "documents"
  | "inventory"
  | "inbox"
  | "daily_tasks"
  | "appointments"
  | "service_desk"
  | "business_documents"
  | "owner_recommendations"
  | "starter_bot"
  | "revenue";

export const HOME_MODULES: readonly HomeModule[] = [
  "billing",
  "documents",
  "inventory",
  "inbox",
  "daily_tasks",
  "appointments",
  "service_desk",
  "business_documents",
  "owner_recommendations",
  "starter_bot",
  "revenue",
];

export type CapabilitiesWire = {
  businessId?: number;
  features?: Record<string, { allowed?: boolean } | undefined>;
  /** Phase 2: present only while `activity_packs` is ON for the business (null = on, never chose). */
  activity?: { primary?: unknown; additional?: unknown } | null;
  /** Reserved for the subscription mechanism (not built yet): only `FREE_LIMITED` changes what the Home draws. */
  subscription?: { state?: unknown } | null;
};

/** Layer 1. Fail-closed: a module is in the set only when the server said `allowed: true`. */
export type HomeModules = ReadonlySet<HomeModule>;

export function modulesFromCapabilities(wire: CapabilitiesWire | null | undefined): HomeModules {
  const out = new Set<HomeModule>();
  for (const m of HOME_MODULES) if (wire?.features?.[m]?.allowed === true) out.add(m);
  return out;
}

/** Layer 2. What the business mostly does — for emphasis and default order only. */
export type BusinessKind = "service" | "booking" | "sales" | "general";

const SERVICE_CATEGORIES = new Set(["Home Services", "Automotive", "Device Repair", "Installations", "IT Services"]);
const BOOKING_CATEGORIES = new Set(["Beauty", "Fitness"]);
const SALES_CATEGORIES = new Set(["Professional Services", "Events", "Retail", "Food"]);

export type BusinessProfileWire = { profile?: { category?: string | null; businessModel?: string | null } | null } | null;

export function businessKindOf(profile: BusinessProfileWire | undefined): BusinessKind {
  const category = profile?.profile?.category?.trim() ?? "";
  if (SERVICE_CATEGORIES.has(category)) return "service";
  if (BOOKING_CATEGORIES.has(category)) return "booking";
  if (SALES_CATEGORIES.has(category)) return "sales";
  return "general";
}

/** Layer 3. What the signed-in person may see on the Home. */
export type HomeScope = "money" | "customers" | "operations" | "documents";

export type UserPermissions = { readonly scopes: ReadonlySet<HomeScope> };

const ALL_SCOPES: ReadonlySet<HomeScope> = new Set<HomeScope>(["money", "customers", "operations", "documents"]);

/**
 * Today: the only person signed in to a business is its owner, who sees all of it. A future membership/role source
 * replaces the body of this function — never the callers — and may only REMOVE scopes.
 */
export function resolveUserPermissions(): UserPermissions {
  return { scopes: ALL_SCOPES };
}

/**
 * Layer 2b (phase 2). The activity packs the owner chose — display only, like `kind`, and it replaces `kind` as the
 * source of order when present. `null` = the feature is OFF or the owner never chose: the Home is the pre-packs one.
 * Only the server's answer counts, and only while the feature is ON for the business (fail-closed: never guessed).
 */
export function rawActivityFromCapabilities(wire: CapabilitiesWire | null | undefined): unknown {
  // The selection is VALIDATED by the pack engine (selectionOf), downloaded only when this is non-null: the parser
  // ships to no business without packs. No engine = no selection (fail-closed).
  return wire?.features?.activity_packs?.allowed === true && wire.activity ? wire.activity : null;
}

/**
 * The subscription state the Home must reflect. The plan / subscription model does not exist yet (phase 1 shipped
 * only the shadow guard): today this is always `null`. When the mechanism lands it adds `subscription.state` to the
 * capabilities answer and FREE_LIMITED switches the Home to its view-and-export form (status line, one plan card,
 * allowed "+" actions only). Anything else, or nothing, means "draw what feature access allows" — unchanged.
 */
export type SubscriptionView = "FREE_LIMITED" | null;

export function subscriptionFromCapabilities(wire: CapabilitiesWire | null | undefined): SubscriptionView {
  return wire?.subscription?.state === "FREE_LIMITED" ? "FREE_LIMITED" : null;
}

/**
 * Where "בחירת מסלול" leads — supplied by the subscription mechanism with its state (an in-app path only). No such
 * screen exists today, so this is null and the Home draws the plan text WITHOUT a link rather than a dead one.
 */
export function planHrefFromCapabilities(wire: CapabilitiesWire | null | undefined): string | null {
  const h = (wire?.subscription as { manageHref?: unknown } | null | undefined)?.manageHref;
  return typeof h === "string" && h.startsWith("/") && !h.startsWith("//") ? h : null;
}

/**
 * The pack ordering engine (features/home/v4/activity-packs-home.ts). It is loaded ON DEMAND, only for a business
 * that chose packs (pack-engine-loader.ts) — every other business never downloads it. It only REORDERS what feature
 * access and the person's scope already permit; it never adds a capability. Until it is loaded (or if loading
 * fails) the Home uses the pre-packs order: never a wrong capability, at worst the old order.
 */
export type PackEngine = {
  /** The pack-only texts by full message key (see packTranslator). */
  messages: (locale: string) => Readonly<Record<string, string>>;
  /** The validated selection from the raw capabilities value, or null (garbage -> null: fail-closed). */
  selectionOf: (raw: unknown) => ActivitySelection | null;
  orderMetrics: <K extends string>(selection: ActivitySelection, permitted: readonly K[]) => K[];
  orderKeys: <T>(selection: ActivitySelection, items: readonly T[], keyOf: (t: T) => string, list: "create" | "favorites") => T[];
  /**
   * The secretary's groups (kind + ranked items, most urgent first) reordered for the packs: among groups of the SAME
   * urgency the packs' kinds come first; a more urgent group is never pushed down. Stable otherwise.
   */
  secretaryGroups: <G extends readonly [string, readonly { rank: number }[]]>(selection: ActivitySelection, groups: readonly G[]) => G[];
  favoriteKeys: (selection: ActivitySelection, lead: readonly string[]) => string[];
  barSlot: (selection: ActivitySelection | null, modules: ReadonlySet<HomeModule>, scopes?: ReadonlySet<HomeScope>) => BarSlotKey;
};

export type HomeAccess = {
  /** The session business (from the capabilities answer) — keys the per-business display preferences. */
  businessId: number | null;
  modules: HomeModules;
  kind: BusinessKind;
  permissions: UserPermissions;
  /** Phase 2 activity packs (display only). Absent or null = the pre-packs Home. */
  activity?: ActivitySelection | null;
  /** The loaded pack engine — present only with `activity`. Absent = the pre-packs order. */
  packs?: PackEngine | null;
  /** FREE_LIMITED when the subscription says so (never today). Absent or null = unchanged. */
  subscription?: SubscriptionView;
  /** The plan screen, when the subscription mechanism names one (null today). */
  planHref?: string | null;
};

/**
 * The translator with the pack-only texts in front of the dictionary. Without the engine it is `t` itself: those keys
 * are requested only while packs are active (pack-only metrics, READY cases, the new-case action, the appointments
 * label), and then the engine is always loaded (loadActivity gives the selection and the engine together).
 */
export function packTranslator(t: Translator, packs: PackEngine | null | undefined, locale: string): Translator {
  if (!packs) return t;
  const m = packs.messages(locale);
  return (key: MessageKey, vars) => {
    const s = m[key as string];
    return s === undefined ? t(key, vars) : s.replace(/\{(\w+)\}/g, (all, name: string) => (vars && name in vars ? String(vars[name]) : all));
  };
}

/** A requirement: every listed module ON (none = core), and the person holds the scope. */
export type Requirement = { modules?: readonly HomeModule[]; scope: HomeScope };

export function allows(access: HomeAccess, req: Requirement): boolean {
  if (!access.permissions.scopes.has(req.scope)) return false;
  return (req.modules ?? []).every((m) => access.modules.has(m));
}
