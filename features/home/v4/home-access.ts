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

export type CapabilitiesWire = { businessId?: number; features?: Record<string, { allowed?: boolean } | undefined> };

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

export type HomeAccess = {
  /** The session business (from the capabilities answer) — keys the per-business display preferences. */
  businessId: number | null;
  modules: HomeModules;
  kind: BusinessKind;
  permissions: UserPermissions;
};

/** A requirement: every listed module ON (none = core), and the person holds the scope. */
export type Requirement = { modules?: readonly HomeModule[]; scope: HomeScope };

export function allows(access: HomeAccess, req: Requirement): boolean {
  if (!access.permissions.scopes.has(req.scope)) return false;
  return (req.modules ?? []).every((m) => access.modules.has(m));
}
