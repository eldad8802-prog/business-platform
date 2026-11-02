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

import { he } from "@/lib/i18n/messages/he";
import type { insightsHe } from "@/lib/i18n/messages/areas/insights";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

import { pathnameOf } from "./safe-path";

/** A fallback label's dictionary entry (`insights.backNav.*`). */
export type BackLabelKey = keyof typeof insightsHe.backNav;

const HE_T: Translator = createTranslator(he);

function backLabel(key: BackLabelKey, t: Translator = HE_T): string {
  return t(`insights.backNav.${key}`);
}

export type RouteRule = {
  pattern: string;
  root?: boolean;
  /** Fallback parent path (only when no verified origin exists). */
  parent?: string;
  /** Visible label for the fallback, phrased as a destination ("לרשימת …") — the Hebrew text of `parentLabelKey`. */
  parentLabel?: string;
  /** The fallback label's dictionary key, so a surface can show it in the interface language. */
  parentLabelKey?: BackLabelKey;
  /** Never a back destination. */
  transient?: boolean;
  /** Query params that distinguish screens on the same pathname. */
  identityParams?: readonly string[];
};

export const HOME_FALLBACK = { url: "/app", label: "לבית" } as const;

/** Rules as declared: labels by key. `ROUTE_RULES` adds each one's Hebrew `parentLabel`. */
const DECLARED_RULES: readonly Omit<RouteRule, "parentLabel">[] = [
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
  // Daily Tasks (flag daily_tasks): the task centre. `new` opens the create form from "+"; `item` is the selection.
  { pattern: "/tasks", root: true },
  // Appointments milestone B (flag appointments): the calendar; its settings screens return to it.
  { pattern: "/calendar", root: true },
  { pattern: "/settings", root: true },
  // Sidebar business card (desktop / tablet) and the Settings hub.
  { pattern: "/profile", root: true },
  // Admin Control Center: the sidebar / bottom-bar destinations are roots; the
  // business list keeps its search, filter and page per history entry.
  { pattern: "/admin", root: true },
  { pattern: "/admin/audit", root: true },
  { pattern: "/admin/businesses", root: true },
  { pattern: "/admin/security", root: true },
  { pattern: "/admin/diagnostics", parent: "/admin/security", parentLabelKey: "toSecurityTools" },
  { pattern: "/admin/accountant-ops", parent: "/admin/security", parentLabelKey: "toSecurityTools" },
  { pattern: "/admin/businesses/[id]", parent: "/admin/businesses", parentLabelKey: "toBusinessList" },
  { pattern: "/admin/businesses/[id]/features", parent: "/admin/businesses/[id]", parentLabelKey: "toBusinessDetails" },

  // ---- screens reached from Home (not in the main navigation) ------------
  { pattern: "/pricing", parent: "/app", parentLabelKey: "toHome", identityParams: ["step"] },
  // Setup after signup: two steps; finishing consumes them, so Back from Home
  // never re-enters a completed setup.
  { pattern: "/setup", parent: "/app", parentLabelKey: "toHome", identityParams: ["step"] },
  { pattern: "/revenue", parent: "/app", parentLabelKey: "toHome", identityParams: ["view", "cstep"] },
  { pattern: "/revenue/redeem", parent: "/revenue", parentLabelKey: "toMyCoupons", identityParams: ["step"] },
  { pattern: "/revenue/coupons/[id]", parent: "/revenue", parentLabelKey: "toCoupons" },
  // Dubiz recommendations (owner_recommendations): the list, and one recommendation with its WHY.
  { pattern: "/recommendations", parent: "/app", parentLabelKey: "toHome" },
  { pattern: "/recommendations/[id]", parent: "/recommendations", parentLabelKey: "toAllRecommendations" },

  // ---- content creation flow (each step's fallback = the step before) ----
  { pattern: "/content", parent: "/app", parentLabelKey: "toHome" },
  { pattern: "/content/goal", parent: "/content", parentLabelKey: "toContentCreation" },
  { pattern: "/content/archetype", parent: "/content/goal", parentLabelKey: "toGoalPicker" },
  { pattern: "/content/setup", parent: "/content/archetype", parentLabelKey: "toStylePicker" },
  { pattern: "/content/creator-plan", parent: "/content/setup", parentLabelKey: "toContentSettings" },
  { pattern: "/content/shot-direction", parent: "/content/creator-plan", parentLabelKey: "toContentPlan" },
  { pattern: "/content/assets-upload", parent: "/content/shot-direction", parentLabelKey: "toShotDirection" },
  { pattern: "/content/ai-assets", parent: "/content/creator-plan", parentLabelKey: "toContentPlan" },
  // Render starts a new (quota-consuming) job on every visit: never go back INTO it.
  { pattern: "/content/render", transient: true, parent: "/content/creator-plan", parentLabelKey: "toContentPlan" },
  { pattern: "/content/result", parent: "/content", parentLabelKey: "toContentCreation" },
  // Legacy steps still routable (not linked from the current flow).
  ...[
    "/content/ai-brief", "/content/assets", "/content/context", "/content/create", "/content/direction",
    "/content/flow", "/content/format", "/content/generate", "/content/intent", "/content/mode",
    "/content/style", "/content/summary", "/content/value",
  ].map((pattern) => ({ pattern, parent: "/content", parentLabelKey: "toContentCreation" as const })),

  // ---- redirect stubs: never a back destination --------------------------
  { pattern: "/payments", transient: true, parent: "/collection", parentLabelKey: "toCollection" },
  { pattern: "/payments/new", transient: true, parent: "/collection", parentLabelKey: "toCollection" },
  { pattern: "/payments/[id]", transient: true, parent: "/collection", parentLabelKey: "toCollection" },
  { pattern: "/business/bot/setup/success", transient: true, parent: "/business/bot", parentLabelKey: "toMyBot" },

  // ---- secondary hubs -----------------------------------------------------
  { pattern: "/attention", parent: "/app", parentLabelKey: "toHome" },

  // ---- documents ------------------------------------------------------------
  { pattern: "/documents/inbox", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/review/[id]", parent: "/documents", parentLabelKey: "toDocumentList" },
  { pattern: "/documents/search", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/upload", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/email", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/accountant-pack", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/dashboard", parent: "/documents", parentLabelKey: "toDocuments" },
  { pattern: "/documents/uniform-export", parent: "/documents", parentLabelKey: "toDocuments" },

  // ---- billing / payables / collection -----------------------------------
  { pattern: "/billing/[id]", parent: "/billing", parentLabelKey: "toInvoiceList" },
  { pattern: "/payables/[id]", parent: "/payables", parentLabelKey: "toAllPayables" },
  { pattern: "/payables/bank", parent: "/payables", parentLabelKey: "toAllPayables" },
  { pattern: "/payables/bank/import", parent: "/payables", parentLabelKey: "toAllPayables" },
  { pattern: "/payables/cheques", parent: "/payables", parentLabelKey: "toAllPayables" },
  { pattern: "/payables/match/[documentId]", parent: "/payables", parentLabelKey: "toAllPayables" },

  // ---- calendar (Appointments milestone B) --------------------------------
  // Design direction A (2026-11-02): settings live under "ניהול היומן"; each page returns there, a member / service to its list.
  { pattern: "/calendar/manage", parent: "/calendar", parentLabelKey: "toCalendar" },
  { pattern: "/calendar/hours", parent: "/calendar/manage", parentLabelKey: "toCalendarManage" },
  { pattern: "/calendar/special-days", parent: "/calendar/manage", parentLabelKey: "toCalendarManage" },
  { pattern: "/calendar/staff", parent: "/calendar/manage", parentLabelKey: "toCalendarManage" },
  { pattern: "/calendar/staff/[id]", parent: "/calendar/staff", parentLabelKey: "toCalendarStaff" },
  { pattern: "/calendar/services", parent: "/calendar/manage", parentLabelKey: "toCalendarManage" },
  { pattern: "/calendar/services/[id]", parent: "/calendar/services", parentLabelKey: "toCalendarServices" },
  { pattern: "/calendar/booking", parent: "/calendar/manage", parentLabelKey: "toCalendarManage" },
  { pattern: "/collection/new", parent: "/collection", parentLabelKey: "toCollection", identityParams: ["step"] },
  { pattern: "/collection/c/[customerId]", parent: "/collection", parentLabelKey: "toCollection" },

  // ---- CRM ------------------------------------------------------------------
  { pattern: "/customers/[id]", parent: "/customers", parentLabelKey: "toCustomerList" },
  { pattern: "/leads/[id]", parent: "/leads", parentLabelKey: "toLeadList" },
  { pattern: "/suppliers", parent: "/tools/operations", parentLabelKey: "toBusinessManagement" },
  // S1-B M3: the uploads work screen is a tool of the money family.
  { pattern: "/money/uploads", parent: "/tools/money", parentLabelKey: "toMoneyInvoices" },
  { pattern: "/suppliers/[id]", parent: "/suppliers", parentLabelKey: "toSupplierList" },

  // ---- inventory ------------------------------------------------------------
  { pattern: "/inventory/items", parent: "/inventory", parentLabelKey: "toInventory" },
  { pattern: "/inventory/items/create", parent: "/inventory/items", parentLabelKey: "toProductList" },
  { pattern: "/inventory/items/[id]", parent: "/inventory/items", parentLabelKey: "toProductList" },
  { pattern: "/inventory/count", parent: "/inventory", parentLabelKey: "toInventory" },
  { pattern: "/inventory/alerts", parent: "/inventory", parentLabelKey: "toInventory" },
  { pattern: "/inventory/drafts", parent: "/inventory/items", parentLabelKey: "toProductList" },
  { pattern: "/inventory/unmatched", parent: "/inventory/sales", parentLabelKey: "toSales" },
  { pattern: "/inventory/sales", parent: "/inventory", parentLabelKey: "toInventory" },
  { pattern: "/inventory/sales/create", parent: "/inventory/sales", parentLabelKey: "toSales" },
  { pattern: "/inventory/supplier-purchases", parent: "/inventory", parentLabelKey: "toInventory" },
  { pattern: "/inventory/supplier-purchases/history", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/import", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/integrations", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/pending", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/new", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/new/cart", parent: "/inventory/supplier-purchases/new", parentLabelKey: "toProductPicker" },
  { pattern: "/inventory/supplier-purchases/new/confirm", parent: "/inventory/supplier-purchases/new/cart", parentLabelKey: "toOrderBasket" },
  { pattern: "/inventory/supplier-purchases/[id]/send", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },
  { pattern: "/inventory/supplier-purchases/[id]/receive", parent: "/inventory/supplier-purchases", parentLabelKey: "toOrderCenter" },

  // ---- settings / business / tools ----------------------------------------
  { pattern: "/settings/whatsapp", parent: "/settings/connections", parentLabelKey: "toConnections" },
  // M7-B — the Dubiz Wix app's confirm page (Wix opens it after install).
  { pattern: "/settings/connections/wix", parent: "/settings/connections", parentLabelKey: "toConnections" },
  { pattern: "/settings/account", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/business", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/connections", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/inbound-email", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/security", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/team", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/workspace", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/import-export", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/settings/import-export/documents", parent: "/settings/import-export", parentLabelKey: "toImportExport" },
  { pattern: "/settings/import-export/export", parent: "/settings/import-export", parentLabelKey: "toImportExport" },
  { pattern: "/settings/import-export/import", parent: "/settings/import-export", parentLabelKey: "toImportExport" },
  { pattern: "/settings/import-export/templates", parent: "/settings/import-export", parentLabelKey: "toImportExport" },
  { pattern: "/settings/import-export/historical", parent: "/settings/import-export", parentLabelKey: "toImportExport" },
  { pattern: "/settings/import-export/historical/records", parent: "/settings/import-export/historical", parentLabelKey: "toHistoricalData" },
  { pattern: "/settings/import-export/historical/records/[id]", parent: "/settings/import-export/historical/records", parentLabelKey: "toRecordList" },
  // The /tools catalogue is retired (next.config → /app); each family screen is reached from Home.
  { pattern: "/tools/[category]", parent: "/app", parentLabelKey: "toHome" },
  { pattern: "/business", parent: "/settings", parentLabelKey: "toSettings" },
  { pattern: "/business/identity", parent: "/business", parentLabelKey: "toBusinessProfile" },
  { pattern: "/business/landing-strategy", parent: "/business/identity", parentLabelKey: "toDigitalPresence" },
  // P3-E: ?strategy= (a fresh composition) and ?version= (a saved version) are different screens.
  { pattern: "/business/landing-preview", parent: "/business/landing-strategy", parentLabelKey: "toLandingDirections", identityParams: ["strategy", "version"] },
  { pattern: "/business/landing", parent: "/business/identity", parentLabelKey: "toDigitalPresence" },
  { pattern: "/business/bot", parent: "/tools/customers", parentLabelKey: "toCustomersSales" },
  { pattern: "/business/bot-settings", parent: "/business/bot", parentLabelKey: "toMyBot" },
  { pattern: "/business/bot-settings/[area]", parent: "/business/bot-settings", parentLabelKey: "toBotSettings" },
];

export const ROUTE_RULES: readonly RouteRule[] = DECLARED_RULES.map((rule) =>
  rule.parentLabelKey ? { ...rule, parentLabel: backLabel(rule.parentLabelKey) } : rule
);

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
 * With `t`, in the interface language; without it, the Hebrew it always was.
 */
export function labelForDestination(url: string, t?: Translator): string {
  const pathname = pathnameOf(url);
  if (pathname === HOME_FALLBACK.url) return t ? backLabel("toHome", t) : HOME_FALLBACK.label;
  const rule = ROUTE_RULES.find((r) => r.parent === pathname && r.parentLabel);
  if (!t) return rule?.parentLabel ?? "חזרה";
  return rule?.parentLabelKey ? backLabel(rule.parentLabelKey, t) : backLabel("back", t);
}

/**
 * The declared fallback for a screen: its registered parent, else Home (every
 * real sub-route is registered — route-registry.test.ts enforces it — so Home
 * is only a safety net). Never returns the screen itself.
 */
export function fallbackFor(pathname: string, t?: Translator): { url: string; label: string } {
  const rule = findRouteRule(pathname);
  if (rule?.parent && rule.parent !== pathname) {
    if (t) return { url: rule.parent, label: backLabel(rule.parentLabelKey ?? "toHome", t) };
    return { url: rule.parent, label: rule.parentLabel ?? HOME_FALLBACK.label };
  }
  return t ? { url: HOME_FALLBACK.url, label: backLabel("toHome", t) } : { ...HOME_FALLBACK };
}
