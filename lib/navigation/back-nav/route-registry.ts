/**
 * Route registry for back navigation — the single declaration of:
 *  - ROOT screens: top-level destinations (main nav, public entry points).
 *    They never render a back control.
 *  - the FALLBACK parent of every sub-screen, used ONLY when there is no
 *    verified in-app screen the user came from (direct link, new tab, a chain
 *    that crosses accounts). The fallback carries an explicit label ("לרשימת
 *    המסמכים") so it is never presented as the screen the user came from.
 *  - TRANSIENT screens that are never a back destination (redirect stubs,
 *    flow completions).
 *  - identity params for screens routed by query (Secretary `?screen=`, Inbox
 *    `?conversationId=`): two URLs on one pathname are different screens when
 *    these differ.
 *
 * Patterns use the App Router segment syntax: "/documents/review/[id]".
 * Lookup is most-specific-first; an unregistered path falls back to its
 * nearest registered ancestor, and finally to Home.
 */

import { pathnameOf } from "./safe-path";

export type RouteRule = {
  pattern: string;
  root?: boolean;
  /** Fallback parent path (only when no verified origin exists). */
  parent?: string;
  /** Visible label for the fallback, phrased as a destination ("לרשימת …"). */
  parentLabel?: string;
  /** Never a back destination. */
  transient?: boolean;
  /** Query params that distinguish screens on the same pathname. */
  identityParams?: readonly string[];
};

export const HOME_FALLBACK = { url: "/app", label: "לבית" } as const;

export const ROUTE_RULES: readonly RouteRule[] = [
  // ---- roots (main navigation destinations and entry points) -------------
  { pattern: "/app", root: true },
  { pattern: "/", root: true, transient: true },
  { pattern: "/inbox", root: true, identityParams: ["conversationId", "list"] },
  { pattern: "/documents", root: true },
  { pattern: "/notifications", root: true },
  { pattern: "/search", root: true },
  { pattern: "/inventory", root: true },
  { pattern: "/leads", root: true },
  { pattern: "/customers", root: true },
  { pattern: "/collection", root: true },
  { pattern: "/billing", root: true },
  { pattern: "/secretary", root: true, identityParams: ["screen", "today", "id", "loopMode"] },
  { pattern: "/payables", root: true },
  { pattern: "/settings", root: true },
  // Sidebar business card (desktop / tablet) and the Settings hub.
  { pattern: "/profile", root: true },
  { pattern: "/admin", root: true },
  { pattern: "/admin/audit", root: true },
  { pattern: "/admin/businesses/[id]", parent: "/admin", parentLabel: "ללוח הבקרה" },
  { pattern: "/admin/businesses/[id]/features", parent: "/admin/businesses/[id]", parentLabel: "לפרטי העסק" },

  // ---- screens reached from Home (not in the main navigation) ------------
  { pattern: "/pricing", parent: "/app", parentLabel: "לבית", identityParams: ["step"] },
  // Setup after signup: two steps; finishing consumes them, so Back from Home
  // never re-enters a completed setup.
  { pattern: "/setup", parent: "/app", parentLabel: "לבית", identityParams: ["step"] },
  { pattern: "/revenue", parent: "/app", parentLabel: "לבית", identityParams: ["view", "cstep"] },
  { pattern: "/revenue/redeem", parent: "/revenue", parentLabel: "לקופונים שלי", identityParams: ["step"] },
  { pattern: "/revenue/coupons/[id]", parent: "/revenue", parentLabel: "לקופונים" },
  // Dubiz recommendations (owner_recommendations): the list, and one recommendation with its WHY.
  { pattern: "/recommendations", parent: "/app", parentLabel: "לבית" },
  { pattern: "/recommendations/[id]", parent: "/recommendations", parentLabel: "לכל ההמלצות" },

  // ---- content creation flow (each step's fallback = the step before) ----
  { pattern: "/content", parent: "/app", parentLabel: "לבית" },
  { pattern: "/content/goal", parent: "/content", parentLabel: "ליצירת תוכן" },
  { pattern: "/content/archetype", parent: "/content/goal", parentLabel: "לבחירת המטרה" },
  { pattern: "/content/setup", parent: "/content/archetype", parentLabel: "לבחירת הסגנון" },
  { pattern: "/content/creator-plan", parent: "/content/setup", parentLabel: "להגדרות התוכן" },
  { pattern: "/content/shot-direction", parent: "/content/creator-plan", parentLabel: "לתוכנית התוכן" },
  { pattern: "/content/assets-upload", parent: "/content/shot-direction", parentLabel: "להנחיות הצילום" },
  { pattern: "/content/ai-assets", parent: "/content/creator-plan", parentLabel: "לתוכנית התוכן" },
  // Render starts a new (quota-consuming) job on every visit: never go back INTO it.
  { pattern: "/content/render", transient: true, parent: "/content/creator-plan", parentLabel: "לתוכנית התוכן" },
  { pattern: "/content/result", parent: "/content", parentLabel: "ליצירת תוכן" },
  // Legacy steps still routable (not linked from the current flow).
  ...[
    "/content/ai-brief", "/content/assets", "/content/context", "/content/create", "/content/direction",
    "/content/flow", "/content/format", "/content/generate", "/content/intent", "/content/mode",
    "/content/style", "/content/summary", "/content/value",
  ].map((pattern) => ({ pattern, parent: "/content", parentLabel: "ליצירת תוכן" })),

  // ---- redirect stubs: never a back destination --------------------------
  { pattern: "/payments", transient: true, parent: "/collection", parentLabel: "לגבייה" },
  { pattern: "/payments/new", transient: true, parent: "/collection", parentLabel: "לגבייה" },
  { pattern: "/payments/[id]", transient: true, parent: "/collection", parentLabel: "לגבייה" },
  { pattern: "/business/bot/setup/success", transient: true, parent: "/business/bot", parentLabel: "לבוט שלי" },

  // ---- secondary hubs -----------------------------------------------------
  { pattern: "/attention", parent: "/app", parentLabel: "לבית" },

  // ---- documents ------------------------------------------------------------
  { pattern: "/documents/inbox", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/review/[id]", parent: "/documents", parentLabel: "לרשימת המסמכים" },
  { pattern: "/documents/search", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/upload", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/email", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/accountant-pack", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/dashboard", parent: "/documents", parentLabel: "למסמכים" },
  { pattern: "/documents/uniform-export", parent: "/documents", parentLabel: "למסמכים" },

  // ---- billing / payables / collection -----------------------------------
  { pattern: "/billing/[id]", parent: "/billing", parentLabel: "לרשימת החשבוניות" },
  { pattern: "/payables/[id]", parent: "/payables", parentLabel: "לכל ההתחייבויות" },
  { pattern: "/payables/bank", parent: "/payables", parentLabel: "לכל ההתחייבויות" },
  { pattern: "/payables/cheques", parent: "/payables", parentLabel: "לכל ההתחייבויות" },
  { pattern: "/payables/match/[documentId]", parent: "/payables", parentLabel: "לכל ההתחייבויות" },
  { pattern: "/collection/new", parent: "/collection", parentLabel: "לגבייה", identityParams: ["step"] },
  { pattern: "/collection/c/[customerId]", parent: "/collection", parentLabel: "לגבייה" },

  // ---- CRM ------------------------------------------------------------------
  { pattern: "/customers/[id]", parent: "/customers", parentLabel: "לרשימת הלקוחות" },
  { pattern: "/leads/[id]", parent: "/leads", parentLabel: "לרשימת הלידים" },
  { pattern: "/suppliers", parent: "/tools/operations", parentLabel: "לניהול העסק" },
  { pattern: "/suppliers/[id]", parent: "/suppliers", parentLabel: "לרשימת הספקים" },

  // ---- inventory ------------------------------------------------------------
  { pattern: "/inventory/items", parent: "/inventory", parentLabel: "למלאי" },
  { pattern: "/inventory/items/create", parent: "/inventory/items", parentLabel: "לרשימת המוצרים" },
  { pattern: "/inventory/items/[id]", parent: "/inventory/items", parentLabel: "לרשימת המוצרים" },
  { pattern: "/inventory/count", parent: "/inventory", parentLabel: "למלאי" },
  { pattern: "/inventory/alerts", parent: "/inventory", parentLabel: "למלאי" },
  { pattern: "/inventory/drafts", parent: "/inventory/items", parentLabel: "לרשימת המוצרים" },
  { pattern: "/inventory/unmatched", parent: "/inventory/sales", parentLabel: "למכירות" },
  { pattern: "/inventory/sales", parent: "/inventory", parentLabel: "למלאי" },
  { pattern: "/inventory/sales/create", parent: "/inventory/sales", parentLabel: "למכירות" },
  { pattern: "/inventory/supplier-purchases", parent: "/inventory", parentLabel: "למלאי" },
  { pattern: "/inventory/supplier-purchases/history", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/import", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/integrations", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/pending", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/new", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/new/cart", parent: "/inventory/supplier-purchases/new", parentLabel: "לבחירת מוצרים" },
  { pattern: "/inventory/supplier-purchases/new/confirm", parent: "/inventory/supplier-purchases/new/cart", parentLabel: "לסל ההזמנה" },
  { pattern: "/inventory/supplier-purchases/[id]/send", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },
  { pattern: "/inventory/supplier-purchases/[id]/receive", parent: "/inventory/supplier-purchases", parentLabel: "למרכז ההזמנות" },

  // ---- settings / business / tools ----------------------------------------
  { pattern: "/settings/whatsapp", parent: "/settings/connections", parentLabel: "לחיבורים" },
  { pattern: "/settings/account", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/business", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/connections", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/inbound-email", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/security", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/team", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/workspace", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/import-export", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/settings/import-export/documents", parent: "/settings/import-export", parentLabel: "לייבוא וייצוא" },
  { pattern: "/settings/import-export/export", parent: "/settings/import-export", parentLabel: "לייבוא וייצוא" },
  { pattern: "/settings/import-export/import", parent: "/settings/import-export", parentLabel: "לייבוא וייצוא" },
  { pattern: "/settings/import-export/templates", parent: "/settings/import-export", parentLabel: "לייבוא וייצוא" },
  { pattern: "/settings/import-export/historical", parent: "/settings/import-export", parentLabel: "לייבוא וייצוא" },
  { pattern: "/settings/import-export/historical/records", parent: "/settings/import-export/historical", parentLabel: "לנתונים היסטוריים" },
  { pattern: "/settings/import-export/historical/records/[id]", parent: "/settings/import-export/historical/records", parentLabel: "לרשימת הרשומות" },
  // The /tools catalogue is retired (next.config → /app); each family screen is reached from Home.
  { pattern: "/tools/[category]", parent: "/app", parentLabel: "לבית" },
  { pattern: "/business", parent: "/settings", parentLabel: "להגדרות" },
  { pattern: "/business/identity", parent: "/business", parentLabel: "לפרופיל העסק" },
  { pattern: "/business/landing-strategy", parent: "/business/identity", parentLabel: "לנוכחות הדיגיטלית" },
  { pattern: "/business/landing-preview", parent: "/business/landing-strategy", parentLabel: "לכיווני דף הנחיתה" },
  { pattern: "/business/bot", parent: "/tools/customers", parentLabel: "ללקוחות ומכירות" },
  { pattern: "/business/bot-settings", parent: "/business/bot", parentLabel: "לבוט שלי" },
  { pattern: "/business/bot-settings/[area]", parent: "/business/bot-settings", parentLabel: "להגדרות הבוט" },
];

/* ---------------------------------------------------------------- match -- */

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matches(pattern: string, pathname: string): boolean {
  const p = segments(pattern);
  const s = segments(pathname);
  if (p.length !== s.length) return false;
  return p.every((seg, i) => (seg.startsWith("[") && seg.endsWith("]") ? s[i].length > 0 : seg === s[i]));
}

/** Specificity: more literal segments win over dynamic ones. */
function score(pattern: string): number {
  return segments(pattern).reduce((n, seg) => n + (seg.startsWith("[") ? 1 : 2), 0);
}

export function findRouteRule(pathname: string): RouteRule | null {
  let best: RouteRule | null = null;
  for (const rule of ROUTE_RULES) {
    if (matches(rule.pattern, pathname) && (!best || score(rule.pattern) > score(best.pattern))) {
      best = rule;
    }
  }
  return best;
}

/** A root screen never shows a back control. */
export function isRootPath(pathname: string): boolean {
  return findRouteRule(pathname)?.root === true;
}

export function isTransientPath(pathname: string): boolean {
  return findRouteRule(pathname)?.transient === true;
}

/**
 * Screen identity: pathname + the route's identity params (sorted, only the
 * declared ones). "/secretary?screen=detail&id=4" ≠ "/secretary?screen=all".
 */
export function screenKeyOf(url: string): string {
  const pathname = pathnameOf(url);
  const rule = findRouteRule(pathname);
  if (!rule?.identityParams?.length) return pathname;
  let params: URLSearchParams;
  try {
    params = new URL(url, "https://dubiz.invalid").searchParams;
  } catch {
    return pathname;
  }
  const parts = rule.identityParams
    .map((k) => [k, params.get(k)] as const)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${pathname}?${parts.join("&")}` : pathname;
}

/**
 * Destination label for an arbitrary fallback URL ("/documents" → "למסמכים"),
 * taken from any rule that declares it as a parent. Unknown → "חזרה".
 */
export function labelForDestination(url: string): string {
  const pathname = pathnameOf(url);
  if (pathname === HOME_FALLBACK.url) return HOME_FALLBACK.label;
  const rule = ROUTE_RULES.find((r) => r.parent === pathname && r.parentLabel);
  return rule?.parentLabel ?? "חזרה";
}

/**
 * The declared fallback for a screen: its registered parent, else Home (every
 * real sub-route is registered — route-registry.test.ts enforces it — so Home
 * is only a safety net). Never returns the screen itself.
 */
export function fallbackFor(pathname: string): { url: string; label: string } {
  const rule = findRouteRule(pathname);
  if (rule?.parent && rule.parent !== pathname) {
    return { url: rule.parent, label: rule.parentLabel ?? HOME_FALLBACK.label };
  }
  return { ...HOME_FALLBACK };
}
